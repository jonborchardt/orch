import { existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { STATE_FILE } from './global-setup.ts';

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { home: string; pid: number };
  try {
    process.kill(state.pid);
  } catch {
    /* already gone */
  }
  rmSync(STATE_FILE, { force: true });
  // The server holds the SQLite file until it exits; give it a moment, then remove the scratch home.
  await sleep(500);
  rmSync(state.home, { recursive: true, force: true });
}
