import { existsSync, readFileSync, rmSync } from 'node:fs';

import { STATE_FILE } from './global-setup.ts';

export default function globalTeardown(): void {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { home: string; pid: number };
  try {
    process.kill(state.pid);
  } catch {
    /* already gone */
  }
  rmSync(STATE_FILE, { force: true });
  // The server may hold the SQLite file for a moment; best effort.
  setTimeout(() => {
    rmSync(state.home, { recursive: true, force: true });
  }, 500).unref();
}
