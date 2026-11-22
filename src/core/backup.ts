/**
 * Rules of `orch backup` archives (decision 2026-11-22-local-backup-archive): the manifest, the
 * format version, the allow-list of entry paths, and the checks every archive must pass before
 * it is published or restored. Pure.
 */
import { createHash } from 'node:crypto';

import { ValidationError } from './errors.ts';
import type { TarEntry } from './tar.ts';

export const BACKUP_FORMAT = 'orch-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_PATH = 'manifest.json';
export const DATABASE_PATH = 'orch.sqlite';

export const INCLUDED = [
  'orch.sqlite: a consistent SQLite snapshot (VACUUM INTO)',
  'jobs/<id>/artifacts/**: job artifacts (registered and unregistered regular files)',
  'tickets/<id>/assets/**: ticket assets (regular files)',
];

export const EXCLUDED = [
  'worktrees/ and checkouts/ (Git worktrees, repositories, branches)',
  'runner.json, runner-lock/, runner.stop-* (factory controller state)',
  'verify.lock, verify-queue/ (verification queue)',
  'recovery.pid, recovery-status.json (recovery worker)',
  'logs/, tmp/',
  'orch.sqlite-wal, orch.sqlite-shm (folded into the snapshot)',
  'backups/ and every other file in the data directory',
  'user configuration (<config>/factory.json)',
];

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  format: string;
  formatVersion: number;
  createdAt: string;
  orchVersion: string;
  /** Migration names recorded in the snapshot's __drizzle_migrations, in order. */
  schema: { migrations: string[] };
  database: ManifestFile & { rows: Record<string, number> };
  files: ManifestFile[];
  included: string[];
  excluded: string[];
  /** Entries found under artifact or asset directories that are not regular files. */
  skipped: { path: string; reason: string }[];
}

export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why `p` may not be an archive entry, or null when it is safe and on the allow-list. */
export function entryPathProblem(p: string): string | null {
  if (p === '') return 'empty path';
  if (p.includes('\\')) return 'backslash in path';
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return 'absolute path';
  if (p.includes('\0')) return 'NUL in path';
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return '".." segment';
  if (segs.some((s) => s === '' || s === '.')) return 'empty or "." segment';
  // A colon anywhere is a drive letter or an NTFS alternate data stream.
  if (segs.some((s) => s.includes(':'))) return 'colon in path';
  if (segs.some((s) => /[. ]$/.test(s) || WINDOWS_RESERVED.test(s))) {
    return 'Windows reserved name or trailing "." or space';
  }
  if (p === MANIFEST_PATH || p === DATABASE_PATH) return null;
  if (segs.length >= 4 && segs[0] === 'jobs' && segs[2] === 'artifacts') return null;
  if (segs.length >= 4 && segs[0] === 'tickets' && /^\d+$/.test(segs[1] ?? '')) {
    if (segs[2] === 'assets') return null;
  }
  return 'outside the allow-list (orch.sqlite, jobs/<id>/artifacts/, tickets/<id>/assets/)';
}

function isFile(x: unknown): x is ManifestFile {
  const f = x as Partial<ManifestFile> | null;
  return (
    typeof f === 'object' &&
    f !== null &&
    typeof f.path === 'string' &&
    typeof f.bytes === 'number' &&
    Number.isInteger(f.bytes) &&
    f.bytes >= 0 &&
    typeof f.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(f.sha256)
  );
}

/** Parse and check a manifest: supported format and version, every field present and typed. */
export function parseManifest(text: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('Invalid backup manifest: not JSON.');
  }
  const m = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<Manifest>;
  if (m.format !== BACKUP_FORMAT) {
    throw new ValidationError(`Not an orch backup: manifest format is not "${BACKUP_FORMAT}".`);
  }
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new ValidationError(
      `unsupported backup format ${String(m.formatVersion)} (this orch reads format ${String(BACKUP_FORMAT_VERSION)}).`,
    );
  }
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  const problems: string[] = [];
  if (typeof m.createdAt !== 'string') problems.push('createdAt');
  if (typeof m.orchVersion !== 'string') problems.push('orchVersion');
  if (!strings(m.schema?.migrations)) problems.push('schema.migrations');
  const rows = m.database?.rows as unknown;
  if (
    !isFile(m.database) ||
    m.database.path !== DATABASE_PATH ||
    typeof rows !== 'object' ||
    rows === null ||
    !Object.values(rows).every((n) => Number.isInteger(n))
  ) {
    problems.push('database');
  }
  if (!Array.isArray(m.files) || !m.files.every(isFile)) problems.push('files');
  if (!strings(m.included)) problems.push('included');
  if (!strings(m.excluded)) problems.push('excluded');
  if (!Array.isArray(m.skipped)) problems.push('skipped');
  if (problems.length) {
    throw new ValidationError(
      `Invalid backup manifest: missing or malformed ${problems.join(', ')}.`,
    );
  }
  return m as Manifest;
}

export interface CheckedArchive {
  manifest: Manifest;
  database: Buffer;
  /** Artifact and asset files, by archive path. */
  files: Map<string, Buffer>;
}

/**
 * The archive's entries are exactly what its manifest lists: manifest.json first, regular files
 * only, safe allow-listed paths, no duplicates, every hash and size matching.
 */
export function checkArchive(entries: readonly TarEntry[]): CheckedArchive {
  const [first, ...rest] = entries;
  if (first?.path !== MANIFEST_PATH) {
    throw new ValidationError(`Not an orch backup: the first entry is not ${MANIFEST_PATH}.`);
  }
  const manifest = parseManifest(first.data.toString('utf8'));
  const found = new Map<string, Buffer>();
  for (const e of rest) {
    const problem = entryPathProblem(e.path);
    if (problem)
      throw new ValidationError(`Unsafe archive entry ${JSON.stringify(e.path)}: ${problem}.`);
    if (e.type !== '0') {
      throw new ValidationError(`Archive entry ${e.path} is not a regular file (type ${e.type}).`);
    }
    if (e.path === MANIFEST_PATH || found.has(e.path)) {
      throw new ValidationError(`Archive entry ${e.path} appears twice.`);
    }
    found.set(e.path, e.data);
  }
  const matching = (f: ManifestFile): Buffer => {
    const data = found.get(f.path);
    if (data === undefined) throw new ValidationError(`Archive is missing ${f.path}.`);
    if (data.length !== f.bytes || sha256(data) !== f.sha256) {
      throw new ValidationError(`Archive entry ${f.path} does not match its manifest hash.`);
    }
    return data;
  };
  const database = matching(manifest.database);
  const files = new Map<string, Buffer>();
  for (const f of manifest.files) {
    const problem = entryPathProblem(f.path);
    if (problem || f.path === DATABASE_PATH || f.path === MANIFEST_PATH) {
      throw new ValidationError(`Manifest lists an unsafe path ${JSON.stringify(f.path)}.`);
    }
    if (files.has(f.path)) throw new ValidationError(`Manifest lists ${f.path} twice.`);
    files.set(f.path, matching(f));
  }
  for (const p of found.keys()) {
    if (p !== DATABASE_PATH && !files.has(p)) {
      throw new ValidationError(`Archive entry ${p} is not listed in the manifest.`);
    }
  }
  return { manifest, database, files };
}

export interface ArtifactRow {
  jobId: string;
  path: string;
  /** Null on rows registered before hashes were recorded (no backfill). */
  sha256: string | null;
}

/**
 * Registered artifacts whose file is missing or differs from the row. Rows hash the file as
 * UTF-8 text (storage/artifacts.ts validateArtifact), so the comparison does the same. A row
 * without a hash is only checked for presence.
 */
export function artifactMismatches(
  rows: readonly ArtifactRow[],
  files: ReadonlyMap<string, Buffer>,
): { jobId: string; path: string; problem: 'missing' | 'changed' }[] {
  const out: { jobId: string; path: string; problem: 'missing' | 'changed' }[] = [];
  for (const r of rows) {
    const data = files.get(`jobs/${r.jobId}/artifacts/${r.path}`);
    if (data === undefined) out.push({ jobId: r.jobId, path: r.path, problem: 'missing' });
    else if (r.sha256 !== null && sha256(data.toString('utf8')) !== r.sha256) {
      out.push({ jobId: r.jobId, path: r.path, problem: 'changed' });
    }
  }
  return out;
}

/** Refuse a snapshot that recorded migrations this installation does not ship. */
export function requireKnownMigrations(
  recorded: readonly string[],
  shipped: readonly string[],
): void {
  const known = new Set(shipped);
  const unknown = recorded.filter((m) => !known.has(m));
  if (unknown.length) {
    throw new ValidationError(
      `This backup was created by a newer orch: its database has migrations this installation ` +
        `does not know (${unknown.join(', ')}). Upgrade orch, then restore again.`,
    );
  }
}
