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
  client.exec('PRAGMA journal_mode = WAL');
  client.exec('PRAGMA foreign_keys = ON');
  client.exec('PRAGMA busy_timeout = 5000');
  const db = drizzle({ client });
  // Idempotent: records applied migrations in __drizzle_migrations and applies only new ones.
  migrate(db, { migrationsFolder: migrations });
  return {
    db,
    paths,
    file,
    close: () => {
      client.close();
    },
  };
}
