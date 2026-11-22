/**
 * SQLite side of `orch backup`: a consistent snapshot of the live database, and read-only facts
 * about a snapshot file. Raw connections, never migrations: the source is read as it is.
 */
import { DatabaseSync } from 'node:sqlite';

import type { ArtifactRow } from '../core/backup.ts';

/**
 * Write a consistent copy of `source` to `target` with VACUUM INTO: one read transaction, so in
 * WAL mode writers continue, and committed WAL content is included.
 */
export function snapshotDatabase(source: string, target: string): void {
  const db = new DatabaseSync(source);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
}

export interface SnapshotFacts {
  /** `PRAGMA integrity_check`'s first line: 'ok' when sound. */
  integrity: string;
  /** Migration names recorded in __drizzle_migrations, in order. */
  migrations: string[];
  rows: Record<string, number>;
  artifacts: ArtifactRow[];
}

/**
 * Facts about a snapshot file (it only reads). Opened read-write on purpose: a read-only
 * connection to a WAL database leaves -wal and -shm behind, which a restore must not install.
 */
export function inspectSnapshot(file: string): SnapshotFacts {
  const db = new DatabaseSync(file);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    const first = integrity[0] ? String(Object.values(integrity[0])[0]) : 'no result';
    if (first !== 'ok') {
      return { integrity: first, migrations: [], rows: {}, artifacts: [] };
    }
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => String(r['name']));
    const rows: Record<string, number> = {};
    for (const t of tables) {
      rows[t] = Number(
        db.prepare(`SELECT count(*) AS n FROM "${t.replaceAll('"', '""')}"`).get()?.['n'],
      );
    }
    const migrations = tables.includes('__drizzle_migrations')
      ? db
          .prepare('SELECT name FROM __drizzle_migrations WHERE name IS NOT NULL ORDER BY id')
          .all()
          .map((r) => String(r['name']))
      : [];
    // The oldest schemas have an artifacts table without hashes: nothing to compare there.
    const hashed =
      tables.includes('artifacts') &&
      db
        .prepare('PRAGMA table_info(artifacts)')
        .all()
        .some((c) => c['name'] === 'sha256');
    const artifacts = hashed
      ? db
          .prepare('SELECT jobId, path, sha256 FROM artifacts ORDER BY id')
          .all()
          .map((r) => ({
            jobId: String(r['jobId']),
            path: String(r['path']),
            sha256: String(r['sha256']),
          }))
      : [];
    return { integrity: first, migrations, rows, artifacts };
  } finally {
    db.close();
  }
}
