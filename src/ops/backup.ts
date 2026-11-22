/**
 * `orch backup create|restore` (decision 2026-11-22-local-backup-archive): one gzip-compressed
 * tar of a SQLite snapshot, job artifacts, and ticket assets, validated before it is published,
 * and restored only into an inactive, empty data directory through a staging directory.
 */
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  artifactMismatches,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type CheckedArchive,
  checkArchive,
  DATABASE_PATH,
  entryPathProblem,
  EXCLUDED,
  INCLUDED,
  type Manifest,
  MANIFEST_PATH,
  requireKnownMigrations,
  sha256,
} from '../core/backup.ts';
import { NotFoundError, ValidationError } from '../core/errors.ts';
import {
  canonicalPath,
  claudeHome,
  databasePath,
  findProjectRoot,
  installRoot,
  migrationsDir,
  packageInfo,
  type RuntimePaths,
  verifyLockPath,
} from '../core/paths.ts';
import { decodeTar, encodeTar } from '../core/tar.ts';
import { inspectSnapshot, snapshotDatabase, type SnapshotFacts } from '../storage/backup.ts';
import { openStore } from '../storage/client.ts';
import { workerStatus } from './recover.ts';
import { controllerPid } from './runner-state.ts';
import { sleep, verifyLockHolder } from './verify-lock.ts';

/** Snapshots retaken when an artifact file and its row disagree (a concurrent replace). */
const ATTEMPTS = 3;

/** Seams for tests to change files at the moments a race or a corruption would. */
export interface BackupHooks {
  afterSnapshot?: (attempt: number) => void;
  beforePublish?: (tmpFile: string) => void;
  beforeInstallDatabase?: () => void;
}

export interface BackupResult {
  path: string;
  validated: true;
  rows: number;
  tables: Record<string, number>;
  files: number;
  artifacts: number;
  assets: number;
  excluded: string[];
  skipped: { path: string; reason: string }[];
}

export const NOT_RECREATED = [
  'worktrees, Git repositories, and branches',
  'running controllers, recovery workers, and verification queues',
  'logs and temporary files',
  'user configuration (<config>/factory.json)',
];

export interface RestoreResult {
  destination: string;
  rows: number;
  tables: Record<string, number>;
  files: number;
  migrationsApplied: number;
  notRecreated: string[];
}

function inside(p: string, dir: string): boolean {
  const r = relative(canonicalPath(dir), p);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}

function nearestExisting(p: string): string {
  let at = p;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

/** `p` by its canonical spelling, resolving the part of it that exists. */
function canonicalTarget(p: string): string {
  const base = nearestExisting(p);
  const rest = relative(base, p);
  const joined = join(canonicalPath(base), rest);
  return process.platform === 'win32' ? joined.toLowerCase() : joined;
}

function refuseOutput(out: string, paths: RuntimePaths): void {
  const target = canonicalTarget(out);
  const repo = findProjectRoot(nearestExisting(dirname(out)));
  const places: [string, string | undefined][] = [
    ['the orch data directory', paths.data],
    ['the orch installation', installRoot()],
    ['the Claude Code configuration directory', claudeHome()],
    ['a Git working tree', repo],
  ];
  for (const [what, dir] of places) {
    if (dir !== undefined && inside(target, dir)) {
      throw new ValidationError(`Refusing to write a backup inside ${what} (${dir}): ${out}`);
    }
  }
}

interface Collected {
  files: Map<string, Buffer>;
  skipped: { path: string; reason: string }[];
}

/** Regular files under `abs` (archive path `rel`); everything else is reported as skipped. */
function walk(abs: string, rel: string, out: Collected): void {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return; // removed meanwhile
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(join(abs, name), `${rel}/${name}`, out);
  } else if (!st.isFile()) {
    out.skipped.push({
      path: rel,
      reason: st.isSymbolicLink() ? 'symbolic link' : 'not a regular file',
    });
  } else {
    const problem = entryPathProblem(rel);
    if (problem) {
      out.skipped.push({ path: rel, reason: problem });
      return;
    }
    try {
      out.files.set(rel, readFileSync(abs));
    } catch {
      /* removed meanwhile: a registered one is caught as missing */
    }
  }
}

function collect(paths: RuntimePaths): Collected {
  const out: Collected = { files: new Map(), skipped: [] };
  const each = (top: string, sub: string, keep: (name: string) => boolean) => {
    const root = join(paths.data, top);
    if (!existsSync(root)) return;
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && keep(d.name))
        walk(join(root, d.name, sub), `${top}/${d.name}/${sub}`, out);
    }
  };
  each('jobs', 'artifacts', () => true);
  each('tickets', 'assets', (n) => /^\d+$/.test(n));
  return out;
}

function inspect(file: string): SnapshotFacts {
  let facts;
  try {
    facts = inspectSnapshot(file);
  } catch (err) {
    throw new ValidationError(`The backup database cannot be read: ${(err as Error).message}`);
  }
  if (facts.integrity !== 'ok') {
    throw new ValidationError(
      `The backup database fails PRAGMA integrity_check: ${facts.integrity}`,
    );
  }
  return facts;
}

function describeMismatches(bad: ReturnType<typeof artifactMismatches>): string {
  return bad
    .map(
      (b) =>
        `job ${b.jobId}: ${b.path} is ${b.problem === 'missing' ? 'missing' : 'changed since it was registered'}`,
    )
    .join('; ');
}

/** Gunzip and check an archive file: manifest, entry paths, and hashes. Nothing is written. */
export function readArchive(file: string): CheckedArchive {
  let raw: Buffer;
  try {
    raw = gunzipSync(readFileSync(file));
  } catch (err) {
    throw new ValidationError(`Not a readable backup (gzip): ${file}: ${(err as Error).message}`);
  }
  return checkArchive(decodeTar(raw));
}

/** Write the archive's database to `dbFile` and check it and its registered artifacts. */
function checkDatabase(archive: CheckedArchive, dbFile: string): SnapshotFacts {
  writeFileSync(dbFile, archive.database);
  const facts = inspect(dbFile);
  const bad = artifactMismatches(facts.artifacts, archive.files);
  if (bad.length)
    throw new ValidationError(
      `Backup artifacts do not match the database: ${describeMismatches(bad)}`,
    );
  return facts;
}

const total = (rows: Record<string, number>) => Object.values(rows).reduce((a, b) => a + b, 0);

export function createBackup(
  paths: RuntimePaths,
  target: string,
  opts: { force?: boolean | undefined; hooks?: BackupHooks | undefined } = {},
): BackupResult {
  const out = resolve(target);
  refuseOutput(out, paths);
  if (existsSync(out)) {
    if (statSync(out).isDirectory())
      throw new ValidationError(`Backup path is a directory: ${out}`);
    if (!opts.force) {
      throw new ValidationError(`Backup file already exists: ${out}. Pass --force to replace it.`);
    }
  }
  const source = databasePath(paths);
  if (!existsSync(source)) throw new NotFoundError(`No orch database at ${source}.`);

  const work = mkdtempSync(join(tmpdir(), 'orch-backup-'));
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${String(process.pid)}`;
  try {
    const snap = join(work, DATABASE_PATH);
    let facts: SnapshotFacts;
    let found: Collected;
    for (let attempt = 1; ; attempt++) {
      rmSync(snap, { force: true });
      snapshotDatabase(source, snap);
      opts.hooks?.afterSnapshot?.(attempt);
      facts = inspect(snap);
      found = collect(paths);
      const bad = artifactMismatches(facts.artifacts, found.files);
      if (bad.length === 0) break;
      if (attempt === ATTEMPTS) {
        throw new ValidationError(
          `Backup failed; registered artifacts disagree with the database after ${String(ATTEMPTS)} snapshots: ` +
            `${describeMismatches(bad)}. No archive was written.`,
        );
      }
      sleep(200);
    }
    const db = readFileSync(snap);
    const files = [...found.files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      orchVersion: packageInfo().version,
      schema: { migrations: facts.migrations },
      database: { path: DATABASE_PATH, bytes: db.length, sha256: sha256(db), rows: facts.rows },
      files: files.map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) })),
      included: INCLUDED,
      excluded: EXCLUDED,
      skipped: found.skipped,
    };
    const tar = encodeTar(
      [
        { path: MANIFEST_PATH, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
        { path: DATABASE_PATH, data: db },
        ...files.map(([path, data]) => ({ path, data })),
      ],
      Math.floor(Date.now() / 1000),
    );
    // ponytail: built in memory; stream through zlib if asset sets grow beyond memory.
    writeFileSync(tmp, gzipSync(tar), { flag: 'wx' });
    opts.hooks?.beforePublish?.(tmp);
    checkDatabase(readArchive(tmp), join(work, 'check.sqlite'));
    if (!opts.force && existsSync(out))
      throw new ValidationError(`Backup file appeared meanwhile: ${out}`);
    renameSync(tmp, out);
    const artifacts = files.filter(([p]) => p.startsWith('jobs/')).length;
    return {
      path: out,
      validated: true,
      rows: total(facts.rows),
      tables: facts.rows,
      files: files.length,
      artifacts,
      assets: files.length - artifacts,
      excluded: EXCLUDED,
      skipped: found.skipped,
    };
  } finally {
    rmSync(tmp, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

function nonEmptyDir(p: string): boolean {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/** Refuse a destination that holds orch data or that a live orch process uses. */
function refuseActive(paths: RuntimePaths): void {
  const db = databasePath(paths);
  for (const f of [db, `${db}-wal`, `${db}-shm`]) {
    if (existsSync(f))
      throw new ValidationError(
        `Refusing to restore: ${f} exists. Restore into an empty data directory (--data-dir).`,
      );
  }
  for (const d of ['jobs', 'tickets']) {
    const p = join(paths.data, d);
    if (nonEmptyDir(p)) throw new ValidationError(`Refusing to restore: ${p} is not empty.`);
  }
  const pid = controllerPid(paths);
  if (pid !== null)
    throw new ValidationError(
      `Refusing to restore: a factory controller runs for ${paths.data} (PID ${String(pid)}).`,
    );
  const worker = workerStatus(paths);
  if (worker.running)
    throw new ValidationError(
      `Refusing to restore: a recovery worker runs for ${paths.data} (PID ${String(worker.pid)}).`,
    );
  const holder = verifyLockHolder(verifyLockPath(paths));
  if (holder)
    throw new ValidationError(
      `Refusing to restore: orch verify runs for ${paths.data} (PID ${String(holder.pid)}).`,
    );
}

function shippedMigrations(): string[] {
  return readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function restoreBackup(
  file: string,
  paths: RuntimePaths,
  hooks: BackupHooks = {},
): RestoreResult {
  const archiveFile = resolve(file);
  if (!existsSync(archiveFile)) throw new NotFoundError(`No backup file at ${archiveFile}.`);
  const dest = paths.data;
  refuseActive(paths);
  const archive = readArchive(archiveFile);

  mkdirSync(dest, { recursive: true });
  const staging = mkdtempSync(join(dest, '.orch-restore-'));
  const moved: string[] = [];
  try {
    const stagedDb = join(staging, DATABASE_PATH);
    const before = checkDatabase(archive, stagedDb);
    requireKnownMigrations(before.migrations, shippedMigrations());
    for (const [rel, data] of archive.files) {
      const abs = resolve(staging, ...rel.split('/'));
      if (!inside(canonicalTarget(abs), staging))
        throw new ValidationError(`Unsafe archive entry ${rel}.`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data, { flag: 'wx' });
    }
    const stagingPaths: RuntimePaths = {
      config: staging,
      data: staging,
      logs: join(staging, 'logs'),
      tmp: join(staging, 'tmp'),
    };
    openStore(stagingPaths, stagedDb).close(); // applies outstanding migrations; close checkpoints the WAL
    const after = inspect(stagedDb);
    for (const s of ['-wal', '-shm']) {
      if (existsSync(stagedDb + s))
        throw new ValidationError(
          `The migrated database left ${DATABASE_PATH}${s} behind; nothing was restored.`,
        );
    }

    refuseActive(paths);
    for (const d of ['jobs', 'tickets']) {
      if (!existsSync(join(staging, d))) continue;
      if (existsSync(join(dest, d))) rmdirSync(join(dest, d)); // empty (checked); fails if filled meanwhile
      renameSync(join(staging, d), join(dest, d));
      moved.push(d);
    }
    hooks.beforeInstallDatabase?.();
    // Installed last and never over a file: link fails if orch.sqlite appeared meanwhile.
    // ponytail: hard link needs a filesystem that has them (not FAT); the data directory always has.
    linkSync(stagedDb, databasePath(paths));
    moved.length = 0;
    return {
      destination: dest,
      rows: total(after.rows),
      tables: after.rows,
      files: archive.files.size,
      migrationsApplied: after.migrations.length - before.migrations.length,
      notRecreated: NOT_RECREATED,
    };
  } catch (err) {
    for (const d of moved.reverse()) {
      try {
        renameSync(join(dest, d), join(staging, d));
      } catch {
        /* leave it rather than delete restored files */
      }
    }
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ValidationError(
        `Refusing to restore: ${databasePath(paths)} appeared during the restore; nothing was installed.`,
      );
    }
    throw err;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
