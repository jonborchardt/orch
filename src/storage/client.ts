/**
 * The only module that touches the SQLite driver. Opens the shared database, applies pragmas,
 * and runs any outstanding committed migrations. Never resets or recreates an existing database.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

import { databasePath, migrationsDir, type RuntimePaths, runtimePaths } from '../core/paths.ts';

export type Db = NodeSQLiteDatabase;

export interface Store {
  db: Db;
  paths: RuntimePaths;
  file: string;
  close(): void;
}

export function openStore(
  paths: RuntimePaths = runtimePaths(),
  file = databasePath(paths),
  migrations = migrationsDir(),
): Store {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const client = new DatabaseSync(file);
  // busy_timeout first: switching the journal mode takes a lock, and concurrent CLI processes
  // opening the same database must wait for it rather than fail with "database is locked".
  client.exec('PRAGMA busy_timeout = 5000');
  client.exec('PRAGMA journal_mode = WAL');
  client.exec('PRAGMA foreign_keys = ON');
  const db = drizzle({ client });
  // Idempotent: records applied migrations in __drizzle_migrations and applies only new ones.
  // Processes that open a new or just-upgraded database at the same moment all read "not applied"
  // and all run the migration; every one but the first fails on its first statement (the table
  // or column exists) and rolls back. By then the winner has committed, so a second pass finds
  // nothing to do. A loser can also be refused at once with "database is locked" (its read
  // transaction cannot be upgraded while the winner writes; busy_timeout does not apply), so each
  // retry waits a little longer. A failure that outlasts the retries is a real one.
  for (let attempt = 1; ; attempt++) {
    try {
      migrate(db, { migrationsFolder: migrations });
      break;
    } catch (err) {
      if (attempt === 5) {
        client.close();
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
  return {
    db,
    paths,
    file,
    close: () => {
      client.close();
    },
  };
}
