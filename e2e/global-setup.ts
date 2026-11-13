/** Seed a scratch ORCH_HOME and start `orch ui` on the e2e port; state goes to e2e/.state.json. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { homePaths } from '../tests/helpers.ts';
import { seedDashboard } from '../tests/fixtures/dashboard.ts';
import { openStore } from '../src/storage/client.ts';

export const STATE_FILE = join(import.meta.dirname, '.state.json');
const PORT = 4799;

export default async function globalSetup(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'orch-e2e-'));
  const store = openStore(homePaths(home));
  const repos = {
    alpha: join(home, 'repos', 'alpha'),
    beta: join(home, 'repos', 'beta'),
    gamma: join(home, 'repos', 'gamma'),
  };
  for (const d of Object.values(repos)) mkdirSync(d, { recursive: true });
  const ids = seedDashboard(store, repos);
  store.close();

  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, '..', 'src', 'cli', 'main.ts'), 'ui', '--port', String(PORT)],
    { env: { ...process.env, ORCH_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('orch ui did not start'));
    }, 20_000);
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('orch dashboard:')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`orch ui exited with ${String(code)}`));
    });
  });
  writeFileSync(STATE_FILE, JSON.stringify({ home, pid: child.pid, ids, port: PORT }));
  child.unref();
}
