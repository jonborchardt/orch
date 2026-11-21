import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { databasePath, migrationsDir } from '../src/core/paths.ts';
import { openStore } from '../src/storage/client.ts';
import { appendEvent } from '../src/storage/events.ts';
import { createJob, getJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { homePaths, tempDir } from './helpers.ts';

const input = (title = 'T') => ({
  title,
  description: 'Test request',
  repo: 'r',
  repoPath: '/r',
  baseBranch: 'main',
});

/** Run `fn` against a raw connection and always close it. */
function raw<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function shippedMigrations(): string[] {
  return readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** Root cause message of a thrown error (Drizzle wraps driver errors in "Failed query"). */
function rootMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as Error & { cause?: Error };
    return e.cause?.message ?? e.message;
  }
  throw new Error('expected a throw');
}

describe('openStore', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });
  const home = () => {
    const h = tempDir();
    homes.push(h);
    return h;
  };

  it('creates the database from committed migrations with WAL and foreign keys on', () => {
    const paths = homePaths(home());
    openStore(paths).close();
    const file = databasePath(paths);
    expect(existsSync(file)).toBe(true);
    raw(file, (db) => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r['name'])
        .sort();
      expect(tables).toEqual([
        '__drizzle_migrations',
        'artifacts',
        'events',
        'integrations',
        'jobs',
        'reviews',
        'ticket_areas',
        'ticket_events',
        'ticket_links',
        'tickets',
        'verification_checks',
        'verification_runs',
      ]);
      const applied = db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get();
      expect(applied?.['n']).toBe(shippedMigrations().length);
      expect(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
    });
  });

  it('re-opening an existing database is a no-op upgrade that keeps data', () => {
    const paths = homePaths(home());
    const a = openStore(paths);
    const job = createJob(a, input('keep me'));
    a.close();

    const b = openStore(paths);
    try {
      expect(getJob(b.db, job.id).title).toBe('keep me');
    } finally {
      b.close();
    }
    raw(databasePath(paths), (db) => {
      const n = db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()?.['n'];
      expect(n).toBe(shippedMigrations().length);
    });
  });

  it('upgrades a database created by an older migration set without losing rows', () => {
    const h = home();
    const paths = homePaths(h);
    const [first = '', ...rest] = shippedMigrations();
    expect(rest.length).toBeGreaterThan(0);
    // Simulate an older installation: only the first migration shipped.
    const old = join(h, 'old-migrations');
    mkdirSync(old);
    cpSync(join(migrationsDir(), first), join(old, first), { recursive: true });
    const v1 = openStore(paths, databasePath(paths), old);
    v1.close();
    raw(databasePath(paths), (db) => {
      db.prepare(
        `INSERT INTO jobs (id, title, repo, repoPath, baseBranch, stage, status, createdAt, updatedAt)
         VALUES ('job-old', 'legacy', 'r', '/r', 'main', 'spec', 'pending', 't', 't')`,
      ).run();
      const cols = db
        .prepare('PRAGMA table_info(jobs)')
        .all()
        .map((c) => c['name']);
      expect(cols).not.toContain('leaseMinutes');
    });

    // Current installation opens it: new migrations apply, old rows survive with defaults.
    const v2 = openStore(paths);
    try {
      const job = getJob(v2.db, 'job-old');
      expect(job.title).toBe('legacy');
      expect(job.leaseMinutes).toBe(30);
    } finally {
      v2.close();
    }
    raw(databasePath(paths), (db) => {
      const n = db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()?.['n'];
      expect(n).toBe(shippedMigrations().length);
    });
  });

  it('enforces foreign keys and NOT NULL', () => {
    const store = openStore(homePaths(home()));
    try {
      expect(
        rootMessage(() => {
          appendEvent(store.db, 'missing-job', 'x', {}, null, 'now');
        }),
      ).toMatch(/FOREIGN KEY/);
      expect(
        rootMessage(() =>
          store.db
            .insert(jobs)
            // @ts-expect-error deliberately malformed
            .values({ id: 'bad', title: 'no repo', stage: 'spec', status: 'pending' })
            .run(),
        ),
      ).toMatch(/NOT NULL/);
      expect(() => getJob(store.db, 'bad')).toThrow(/No job/);
    } finally {
      store.close();
    }
  });

  it('two connections share one file safely', () => {
    const paths = homePaths(home());
    const a = openStore(paths);
    const b = openStore(paths);
    try {
      const ja = createJob(a, input('from a'));
      const jb = createJob(b, input('from b'));
      expect(getJob(b.db, ja.id).title).toBe('from a');
      expect(getJob(a.db, jb.id).title).toBe('from b');
    } finally {
      a.close();
      b.close();
    }
  });

  it('places the database under the data dir, not the install root or cwd', () => {
    const h = home();
    expect(databasePath(homePaths(h))).toBe(join(h, 'orch.sqlite'));
    expect(migrationsDir()).not.toContain(h);
  });
});
