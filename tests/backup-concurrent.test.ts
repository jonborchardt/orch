/** `orch backup create` while another process keeps writing (AC3). */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { databasePath, installRoot } from '../src/core/paths.ts';
import { createBackup, restoreBackup } from '../src/ops/backup.ts';
import { homePaths, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const src = (rel: string) => pathToFileURL(join(installRoot(), 'src', rel)).href;

/** Opens the store through openStore and adds tickets (each with its event) until `stop` exists. */
const WRITER = `
import { existsSync } from 'node:fs';
const { openStore } = await import(${JSON.stringify(src('storage/client.ts'))});
const { createTicket } = await import(${JSON.stringify(src('storage/tickets.ts'))});
const [home, stop] = process.argv.slice(1);
const paths = { config: home, data: home, logs: home + '/logs', tmp: home + '/tmp' };
const store = openStore(paths);
let n = 0;
try {
  while (!existsSync(stop)) {
    createTicket(store, { title: 'w' + n, repo: 'r', repoPath: '/r' });
    if (++n === 1) console.log('ready');
  }
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
store.close();
console.log('wrote ' + n);
`;

it('backs up while a separate process writes; the writer never sees "database is locked"', async () => {
  const stop = join(tempDir(), 'stop');
  const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER, store.home, stop]);
  let out = '';
  let err = '';
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('ready')) resolve();
    });
    child.on('close', () => {
      reject(new Error(`writer exited early: ${err}`));
    });
  });

  const file = join(tempDir('orch-backup-out-'), 'live.tar.gz');
  const r = createBackup(store.paths, file);
  writeFileSync(stop, '');
  expect(await exited).toBe(0);
  expect(err).toBe('');
  expect(out).toMatch(/wrote \d+/);
  expect(r.validated).toBe(true);
  expect(r.tables['tickets']).toBeGreaterThan(0);

  const dest = join(tempDir(), 'restored');
  restoreBackup(file, homePaths(dest));
  expect(existsSync(databasePath(homePaths(dest)))).toBe(true);
  const db = new DatabaseSync(databasePath(homePaths(dest)));
  try {
    expect(db.prepare('PRAGMA integrity_check').get()?.['integrity_check']).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const tickets = Number(db.prepare('SELECT count(*) AS n FROM tickets').get()?.['n']);
    const events = Number(db.prepare('SELECT count(*) AS n FROM ticket_events').get()?.['n']);
    expect(tickets).toBe(r.tables['tickets']);
    expect(events).toBeGreaterThanOrEqual(tickets);
  } finally {
    db.close();
  }
});
