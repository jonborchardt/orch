/** `orch backup create`: the archive format, contents, output guards, and artifact consistency. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { entryPathProblem, type Manifest, sha256 } from '../src/core/backup.ts';
import { databasePath, installRoot, ticketAssetDir } from '../src/core/paths.ts';
import { decodeTar, encodeTar } from '../src/core/tar.ts';
import { createBackup } from '../src/ops/backup.ts';
import { addTicket } from '../src/ops/tickets.ts';
import { upsertArtifact, findArtifact } from '../src/storage/artifacts.ts';
import { entries, seedJob } from './backup-fixture.ts';
import { json, makeRepo, orch, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let out: string;
beforeEach(() => {
  store = tempStore();
  out = tempDir('orch-backup-out-');
});
afterEach(() => {
  store.cleanup();
});

const manifestOf = (file: string) =>
  JSON.parse(entries(file)[0]?.data.toString('utf8') ?? '') as Manifest;

describe('ustar and entry paths (pure)', () => {
  it('round-trips files, splits long paths into the prefix, and refuses overlong names', () => {
    const long = `jobs/${'a'.repeat(90)}/artifacts/${'b'.repeat(60)}.md`;
    const files = [
      { path: 'manifest.json', data: Buffer.from('{}') },
      { path: long, data: Buffer.alloc(1500, 7) },
      { path: 'tickets/0001/assets/empty', data: Buffer.alloc(0) },
    ];
    const back = decodeTar(encodeTar(files));
    expect(back.map((e) => [e.path, e.type, e.data.length])).toEqual([
      ['manifest.json', '0', 2],
      [long, '0', 1500],
      ['tickets/0001/assets/empty', '0', 0],
    ]);
    expect(back[1]?.data.equals(Buffer.alloc(1500, 7))).toBe(true);
    expect(() => encodeTar([{ path: 'x'.repeat(300), data: Buffer.alloc(1) }])).toThrow(/too long/);
    expect(() => decodeTar(encodeTar(files).subarray(0, 700))).toThrow(/truncated/);
  });

  it('accepts only safe allow-listed paths', () => {
    for (const ok of ['orch.sqlite', 'jobs/job-1/artifacts/spec.md', 'tickets/0007/assets/a.png']) {
      expect(entryPathProblem(ok)).toBeNull();
    }
    for (const bad of [
      '../escape.txt',
      '/abs.txt',
      'C:/x',
      'jobs/a/artifacts/../../x',
      'jobs\\a\\artifacts\\x',
      'jobs/a/artifacts/./x',
      'logs/recovery.log',
      'runner.json',
      'worktrees/r/job/x',
      'tickets/abc/assets/x',
    ]) {
      expect(entryPathProblem(bad), bad).not.toBeNull();
    }
  });
});

describe('createBackup', () => {
  it('archives manifest, snapshot, artifacts and assets in data-directory layout, and nothing else (AC1, AC7, AC9)', () => {
    const c = seedJob(store);
    const assets = ticketAssetDir(1, store.paths);
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, 'shot.png'), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(c.dir, 'notes.txt'), 'unregistered\n');
    // A link inside the artifact directory is reported, never followed.
    const outside = tempDir('orch-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(c.dir, 'link'), 'junction');
    // Runtime files that must never be archived.
    const h = store.home;
    for (const f of ['runner.json', 'verify.lock', 'recovery.pid', 'runner.stop-next']) {
      writeFileSync(join(h, f), '{}');
    }
    for (const d of ['logs', 'tmp', 'verify-queue', 'runner-lock', 'backups']) {
      mkdirSync(join(h, d), { recursive: true });
      writeFileSync(join(h, d, 'x'), 'x');
    }

    const file = join(out, 'b.tar.gz');
    const r = createBackup(store.paths, file);
    expect(r).toMatchObject({ path: file, validated: true, files: 3, artifacts: 2, assets: 1 });
    expect(r.rows).toBeGreaterThan(0);
    expect(r.tables['tickets']).toBe(1);
    expect(r.skipped).toEqual([{ path: `jobs/${c.id}/artifacts/link`, reason: 'symbolic link' }]);
    expect(r.excluded.join('\n')).toMatch(/worktrees/);

    const list = entries(file);
    expect(list.map((e) => e.path)).toEqual([
      'manifest.json',
      'orch.sqlite',
      `jobs/${c.id}/artifacts/notes.txt`,
      `jobs/${c.id}/artifacts/spec.md`,
      'tickets/0001/assets/shot.png',
    ]);
    const m = manifestOf(file);
    expect(m).toMatchObject({ format: 'orch-backup', formatVersion: 1 });
    expect(m.schema.migrations.length).toBe(
      readdirSync(join(installRoot(), 'drizzle'), { withFileTypes: true }).filter((d) =>
        d.isDirectory(),
      ).length,
    );
    const shot = list.find((e) => e.path.endsWith('shot.png'));
    expect(m.files.find((f) => f.path === shot?.path)?.sha256).toBe(
      sha256(Buffer.from([0, 1, 2, 255])),
    );
    expect(m.skipped).toHaveLength(1);
    // No temp file is left next to the archive.
    expect(readdirSync(out)).toEqual(['b.tar.gz']);
  });

  it('includes a transaction committed only in the WAL (AC2)', () => {
    addTicket(store, { title: 'only in the WAL', repo: makeRepo() });
    // The store is still open: nothing has checkpointed the WAL into orch.sqlite.
    expect(statSync(`${databasePath(store.paths)}-wal`).size).toBeGreaterThan(0);
    const file = join(out, 'w.tar.gz');
    createBackup(store.paths, file);
    const db = join(tempDir(), 'snap.sqlite');
    writeFileSync(db, entries(file).find((e) => e.path === 'orch.sqlite')?.data ?? '');
    const raw = new DatabaseSync(db);
    try {
      expect(
        raw
          .prepare('SELECT title FROM tickets')
          .all()
          .map((t) => t['title']),
      ).toEqual(['only in the WAL']);
    } finally {
      raw.close();
    }
  });

  it('publishes nothing when validation fails, and keeps a replaced file intact (AC6)', () => {
    seedJob(store);
    const corrupt = (tmp: string) => {
      const b = readFileSync(tmp);
      writeFileSync(tmp, b.subarray(0, b.length - 40));
    };
    const file = join(out, 'b.tar.gz');
    expect(() => createBackup(store.paths, file, { hooks: { beforePublish: corrupt } })).toThrow(
      /Not a readable backup/,
    );
    expect(readdirSync(out)).toEqual([]);
    writeFileSync(file, 'prior');
    expect(() =>
      createBackup(store.paths, file, { force: true, hooks: { beforePublish: corrupt } }),
    ).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('prior');
    expect(readdirSync(out)).toEqual(['b.tar.gz']);
  });

  it('fails on a missing or changed registered artifact, naming job and path (AC8)', () => {
    const c = seedJob(store);
    const spec = join(c.dir, 'spec.md');
    const file = join(out, 'b.tar.gz');
    const before = readFileSync(spec);
    writeFileSync(spec, before.toString() + '\nedited after registration\n');
    expect(() => createBackup(store.paths, file)).toThrow(
      new RegExp(`job ${c.id}: spec\\.md is changed since it was registered`),
    );
    expect(existsSync(file)).toBe(false);
    rmSync(spec);
    expect(() => createBackup(store.paths, file)).toThrow(
      new RegExp(`job ${c.id}: spec\\.md is missing`),
    );
    expect(readdirSync(out)).toEqual([]);
  });

  it('retakes the snapshot when an artifact and its row are replaced together (AC8)', () => {
    const c = seedJob(store);
    const spec = join(c.dir, 'spec.md');
    const file = join(out, 'b.tar.gz');
    const next = readFileSync(spec, 'utf8') + '\n## Notes\nreplaced\n';
    const r = createBackup(store.paths, file, {
      hooks: {
        afterSnapshot: (attempt) => {
          if (attempt !== 1) return;
          // A concurrent `artifact add --replace`: the file and then its row change.
          writeFileSync(spec, next);
          const row = findArtifact(store.db, c.id, 'spec.md');
          if (row) upsertArtifact(store.db, { ...row, sha256: sha256(next), bytes: next.length });
        },
      },
    });
    expect(r.validated).toBe(true);
    const archived = entries(file).find((e) => e.path === `jobs/${c.id}/artifacts/spec.md`);
    expect(archived?.data.toString()).toBe(next);
    const db = join(tempDir(), 'snap.sqlite');
    writeFileSync(db, entries(file).find((e) => e.path === 'orch.sqlite')?.data ?? '');
    const raw = new DatabaseSync(db);
    try {
      expect(
        raw.prepare("SELECT sha256 FROM artifacts WHERE path = 'spec.md'").get()?.['sha256'],
      ).toBe(sha256(next));
    } finally {
      raw.close();
    }
  });
});

describe('orch backup create (CLI)', () => {
  it('requires a path and refuses data, install, Claude and Git locations (AC4)', () => {
    const cwd = tempDir();
    const r = orch(store.home, cwd, ['backup', 'create']);
    expect(r.code).toBe(2);
    const claude = tempDir('orch-claude-');
    const repo = makeRepo();
    mkdirSync(join(repo, 'sub'));
    for (const [target, what] of [
      [join(store.home, 'b.tar.gz'), 'data directory'],
      [join(installRoot(), 'b.tar.gz'), 'installation'],
      [join(claude, 'b.tar.gz'), 'Claude Code'],
      [join(repo, 'sub', 'deeper', 'b.tar.gz'), 'Git working tree'],
    ] as const) {
      const res = orch(store.home, cwd, ['backup', 'create', target], {
        CLAUDE_CONFIG_DIR: claude,
      });
      expect(res.code, target).toBe(1);
      expect(res.err).toContain(what);
      expect(existsSync(target)).toBe(false);
    }
  });

  it('refuses an existing file unless --force, and reports JSON (AC5, AC7)', () => {
    const cwd = tempDir();
    const file = join(out, 'b.tar.gz');
    writeFileSync(file, 'keep me');
    const refused = orch(store.home, cwd, ['backup', 'create', file]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/already exists/);
    expect(readFileSync(file, 'utf8')).toBe('keep me');
    const forced = orch(store.home, cwd, ['--json', 'backup', 'create', file, '--force']);
    expect(forced.code).toBe(0);
    const r = json<{
      path: string;
      validated: boolean;
      rows: number;
      files: number;
      excluded: string[];
    }>(forced);
    expect(r).toMatchObject({ path: file, validated: true, files: 0 });
    expect(r.excluded.length).toBeGreaterThan(0);
    expect(manifestOf(file).format).toBe('orch-backup');
  });
});
