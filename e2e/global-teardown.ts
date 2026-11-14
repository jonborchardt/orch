import { existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { type E2eState, STATE_ENV } from './global-setup.ts';

export default async function globalTeardown(): Promise<void> {
  const file = process.env[STATE_ENV];
  if (!file || !existsSync(file)) return;
  const state = JSON.parse(readFileSync(file, 'utf8')) as E2eState;
  if (state.pid !== undefined) {
    try {
      process.kill(state.pid);
    } catch {
      /* already gone */
    }
  }
  // ORCH_E2E_KEEP=1 retains this run's scratch home (database, artifacts, state) for debugging.
  if (process.env['ORCH_E2E_KEEP']) {
    console.log(`ORCH_E2E_KEEP set: leaving ${state.home} in place`);
    return;
  }
  // The server holds the SQLite file until it exits; give it a moment, then remove only our home.
  await sleep(500);
  rmSync(state.home, { recursive: true, force: true });
}
