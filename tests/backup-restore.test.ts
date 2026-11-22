/** `orch backup restore`: round trip, refusals, archive validation, migrations, rollback. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePath, migrationsDir, ticketAssetDir, verifyLockPath } from '../src/core/paths.ts';
import { encodeTar } from '../src/core/tar.ts';
import { createBackup, restoreBackup } from '../src/ops/backup.ts';
import { addTicket, addTicketAsset, showTicket } from '../src/ops/tickets.ts';
import { listArtifacts } from '../src/storage/artifacts.ts';
import { openStore } from '../src/storage/client.ts';
import {
  jobDetail,
  listReviews,
  mergeEvidence,
  recordMerge,
  type JobDetail,
} from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import {
  addTicketNote,
  getLinkedTicket,
  listTicketEvents,
  setTicketLink,
} from '../src/storage/tickets.ts';
import { listRuns } from '../src/storage/verification.ts';
import { entries, rewrite, seedJob, withFile } from './backup-fixture.ts';
import { go, head, makePolicyRepo, start, toReview, verdict } from './drive.ts';
import { homePaths, orch, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let out: string;
beforeEach(() => {
  store = tempStore();
  out = tempDir('orch-backup-out-');
});
afterEach(() => {
  store.cleanup();
});

const backup = (name = 'b.tar.gz') => createBackup(store.paths, join(out, name)).path;
const listing = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

/** The read models a restore must reproduce (timestamps and ids included). */
function readModels(s: TempStore | ReturnType<typeof openStore>, jobId: string) {
  const d: JobDetail = jobDetail(s, jobId, 1000);
  return {
    job: d.job,
    events: d.events,
    artifacts: listArtifacts(s.db, jobId),
    reviews: listReviews(s.db, jobId),
    runs: listRuns(s.db, jobId),
    merge: mergeEvidence(s.db, jobId),
    tickets: [1, 2].map((n) => getLinkedTicket(s.db, n)),
    ticketEvents: [1, 2].map((n) => listTicketEvents(s.db, n)),
    assets: showTicket(s, 1).assets,
  };
}

describe('restore round trip', () => {
  it('restores every record and file into --data-dir and migrates it (AC10, AC15, AC17, AC18)', () => {
    const { clone } = makePolicyRepo();
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'start');
    verdict(store, c, 'security');
    store.db
      .update(jobs)
      .set({ prUrl: 'https://github.com/acme/alpha/pull/7', prState: 'draft' })
      .where(eq(jobs.id, c.id))
      .run();
    recordMerge(
      store,
      c.id,
      { token: c.token },
      {
        head: head(c.wt),
        mergeCommit: head(clone),
        verified: true,
        reason: null,
      },
    );
    addTicket(store, { title: 'First', repo: clone });
    addTicket(store, { title: 'Second', repo: clone });
    setTicketLink(store, 2, 1, 'depends_on', true);
    addTicketNote(store, 1, 'a note');
    const shot = join(tempDir(), 'shot.png');
    writeFileSync(shot, Buffer.from([137, 80, 78, 71, 0, 255]));
    addTicketAsset(store, 1, shot);
    writeFileSync(join(store.home, 'runner.json'), '{}');
    mkdirSync(join(store.home, 'logs'), { recursive: true });
    writeFileSync(join(store.home, 'logs', 'recovery.log'), 'log');
    const expected = readModels(store, c.id);
    expect(expected.reviews.length).toBeGreaterThan(0);
    expect(expected.runs.length).toBeGreaterThan(0);
    expect(expected.merge).not.toBeNull();
    expect(expected.tickets[1]?.dependsOn).toEqual([1]);

    const file = backup();
    const dest = join(tempDir(), 'restored', 'deeper');
    const r = orch(store.home, tempDir(), ['backup', 'restore', file, '--data-dir', dest]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Restored into ${dest}`);
    expect(r.out).toMatch(/worktrees, Git repositories, and branches/);
    expect(r.out).toMatch(/user configuration/);
    expect(listing(dest)).toEqual(['jobs', 'orch.sqlite', 'tickets']);

    const restored = openStore(homePaths(dest));
    try {
      expect(readModels(restored, c.id)).toEqual(expected);
      expect(
        readFileSync(join(ticketAssetDir(1, homePaths(dest)), 'shot.png')).equals(
          readFileSync(shot),
        ),
      ).toBe(true);
      expect(readFileSync(join(dest, 'jobs', c.id, 'artifacts', 'build.md'), 'utf8')).toBe(
        readFileSync(join(c.dir, 'build.md'), 'utf8'),
      );
    } finally {
      restored.close();
    }
    const raw = new DatabaseSync(databasePath(homePaths(dest)));
    try {
      expect(raw.prepare('PRAGMA integrity_check').get()?.['integrity_check']).toBe('ok');
    } finally {
      raw.close();
    }
  });

  it('migrates a backup of an older schema forward (AC16)', () => {
    const old = join(tempDir(), 'old-migrations');
    const shipped = readdirSync(migrationsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    mkdirSync(old);
    cpSync(join(migrationsDir(), shipped[0] ?? ''), join(old, shipped[0] ?? ''), {
      recursive: true,
    });
    const home = tempDir();
    openStore(homePaths(home), databasePath(homePaths(home)), old).close();
    const file = createBackup(homePaths(home), join(out, 'old.tar.gz')).path;
    const dest = tempDir();
    const r = restoreBackup(file, homePaths(dest));
    expect(r.migrationsApplied).toBe(shipped.length - 1);
    const raw = new DatabaseSync(databasePath(homePaths(dest)));
    try {
      expect(raw.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()?.['n']).toBe(
        shipped.length,
      );
    } finally {
      raw.close();
    }
  });
});

describe('restore refusals', () => {
  it('refuses a destination with data or a live verify holder, writing nothing (AC11)', () => {
    seedJob(store);
    const file = backup();
    const cwd = tempDir();
    const cases: [string, (d: string) => void][] = [
      [
        'orch.sqlite',
        (d) => {
          writeFileSync(join(d, 'orch.sqlite'), '');
        },
      ],
      [
        'orch.sqlite-wal',
        (d) => {
          writeFileSync(join(d, 'orch.sqlite-wal'), '');
        },
      ],
      ['jobs', (d) => mkdirSync(join(d, 'jobs', 'job-x'), { recursive: true })],
      ['tickets', (d) => mkdirSync(join(d, 'tickets', '0001'), { recursive: true })],
      [
        'orch verify',
        (d) => {
          writeFileSync(
            verifyLockPath(homePaths(d)),
            JSON.stringify({ pid: process.pid, startedAt: 'x' }),
          );
        },
      ],
    ];
    for (const [what, prepare] of cases) {
      const dest = tempDir();
      prepare(dest);
      const before = listing(dest);
      const r = orch(store.home, cwd, ['backup', 'restore', file, '--data-dir', dest]);
      expect(r.code, what).toBe(1);
      expect(r.err, what).toContain(what);
      expect(listing(dest), what).toEqual(before);
    }
    // No overwrite flag exists.
    expect(
      orch(store.home, cwd, ['backup', 'restore', file, '--data-dir', tempDir(), '--force']).code,
    ).toBe(2);
  });

  it('refuses a newer schema or an unsupported format (AC16)', () => {
    seedJob(store);
    const raw = new DatabaseSync(databasePath(store.paths));
    raw
      .prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('x', 0, '29990101000000_future')",
      )
      .run();
    raw.close();
    const file = backup();
    const dest = tempDir();
    expect(() => restoreBackup(file, homePaths(dest))).toThrow(
      /created by a newer orch.*29990101000000_future/,
    );
    expect(listing(dest)).toEqual([]);
    rewrite(file, (m, list) => {
      m.formatVersion = 2;
      return list;
    });
    expect(() => restoreBackup(file, homePaths(dest))).toThrow(/unsupported backup format 2/);
  });

  it('rolls back when orch.sqlite appears before the database is installed (AC14)', () => {
    const c = seedJob(store);
    const file = backup();
    const dest = tempDir();
    expect(() =>
      restoreBackup(file, homePaths(dest), {
        beforeInstallDatabase: () => {
          expect(existsSync(join(dest, 'jobs', c.id))).toBe(true);
          writeFileSync(join(dest, 'orch.sqlite'), 'someone else');
        },
      }),
    ).toThrow(/appeared during the restore/);
    expect(listing(dest)).toEqual(['orch.sqlite']);
    expect(readFileSync(join(dest, 'orch.sqlite'), 'utf8')).toBe('someone else');
  });
});

describe('restore validation', () => {
  let file: string;
  let jobId: string;
  let dest: string;
  beforeEach(() => {
    jobId = seedJob(store).id;
    file = backup();
    dest = tempDir();
  });
  const refused = (pattern: RegExp) => {
    expect(() => restoreBackup(file, homePaths(dest))).toThrow(pattern);
    expect(listing(dest)).toEqual([]);
  };

  it('rejects a non-gzip and a truncated archive (AC12, AC18)', () => {
    const good = readFileSync(file);
    writeFileSync(file, 'plain text');
    refused(/Not a readable backup/);
    writeFileSync(file, good.subarray(0, Math.floor(good.length / 2)));
    refused(/Not a readable backup|truncated/);
  });

  it('rejects an invalid manifest (AC12, AC18)', () => {
    rewrite(file, (m, list) => {
      (m as unknown as Record<string, unknown>)['files'] = 'nope';
      return list;
    });
    refused(/Invalid backup manifest: missing or malformed files/);
    writeFileSync(
      file,
      gzipSync(encodeTar([{ path: 'manifest.json', data: Buffer.from('{oops') }])),
    );
    refused(/not JSON/);
  });

  it('rejects a missing or corrupted artifact and a hash mismatch (AC12, AC18)', () => {
    const spec = `jobs/${jobId}/artifacts/spec.md`;
    const original = readFileSync(file);
    rewrite(file, (m, list) => {
      m.files = m.files.filter((f) => f.path !== spec);
      return list.filter((e) => e.path !== spec);
    });
    refused(new RegExp(`job ${jobId}: spec\\.md is missing`));
    writeFileSync(file, original);
    rewrite(file, (m, list) => {
      const rest = list.filter((e) => e.path !== spec);
      m.files = m.files.filter((f) => f.path !== spec);
      return withFile(m, rest, spec, '# tampered\n');
    });
    refused(new RegExp(`job ${jobId}: spec\\.md is changed`));
    writeFileSync(file, original);
    rewrite(file, (_m, list) =>
      list.map((e) => (e.path === spec ? { ...e, data: Buffer.from('# x\n') } : e)),
    );
    refused(/does not match its manifest hash/);
  });

  it('rejects traversal, absolute, unlisted and link entries, writing nothing outside (AC13, AC18)', () => {
    const parent = join(dest, '..');
    const before = listing(parent);
    const original = readFileSync(file);
    for (const bad of [
      '../escape.txt',
      '/abs.txt',
      'C:/abs.txt',
      'logs/x.log',
      'jobs/a/artifacts/..\\x',
    ]) {
      rewrite(file, (m, list) => withFile(m, list, bad, 'escape'));
      refused(/Unsafe archive entry/);
      writeFileSync(file, original);
    }
    expect(listing(parent)).toEqual(before);
    expect(existsSync(join(parent, 'escape.txt'))).toBe(false);

    // A symbolic-link entry (typeflag 2) on an allowed path: patch the header of the last entry.
    const manifest = entries(file)[0]?.data ?? Buffer.alloc(0);
    const tar = encodeTar([
      { path: 'manifest.json', data: manifest },
      { path: `jobs/${jobId}/artifacts/link`, data: Buffer.alloc(0) },
    ]);
    const at = 512 + Math.ceil(manifest.length / 512) * 512;
    const h = tar.subarray(at, at + 512);
    h.write('2', 156, 1, 'ascii');
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    writeFileSync(file, gzipSync(tar));
    refused(/not a regular file \(type 2\)/);
  });
});
