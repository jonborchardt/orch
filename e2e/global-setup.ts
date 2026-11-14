/**
 * Seed a scratch ORCH_HOME and start `orch ui` for the browser checks. Everything this run owns
 * lives under one mkdtemp directory, and the way to find it (the state file) travels to the
 * workers and the teardown through the environment, so two runs on one machine never share a
 * file, a port, or a database. ORCH_E2E_PORT pins the port (and fails loudly when it is taken);
 * without it the server picks a free one.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { homePaths } from '../tests/helpers.ts';
import { seedDashboard, type SeededJobs } from '../tests/fixtures/dashboard.ts';
import { openStore } from '../src/storage/client.ts';

/** Environment variable naming this run's state file; set here, read by the spec and teardown. */
export const STATE_ENV = 'ORCH_E2E_STATE';

export interface E2eState {
  home: string;
  pid: number | undefined;
  ids: SeededJobs;
  url: string;
}

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

  const requested = process.env['ORCH_E2E_PORT'];
  const port = requested === undefined ? 0 : Number(requested);
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, '..', 'src', 'cli', 'main.ts'), 'ui', '--port', String(port)],
    { env: { ...process.env, ORCH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  let url: string;
  try {
    url = await started(child, port, () => stderr);
  } catch (err) {
    // The teardown never runs when setup fails: leave nothing behind but the error.
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  const state: E2eState = { home, pid: child.pid, ids, url };
  const file = join(home, 'e2e-state.json');
  writeFileSync(file, JSON.stringify(state));
  process.env[STATE_ENV] = file;
  // Workers read baseURL from the state file; this is for anything else that reads the env.
  process.env['ORCH_E2E_URL'] = url;
  child.unref();
}

/** The URL `orch ui` prints once it listens, or a reason it did not. */
function started(child: ChildProcess, port: number, stderr: () => string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('orch ui did not start within 20 s'));
    }, 20_000);
    child.stdout?.on('data', (d: Buffer) => {
      const m = /orch dashboard: (http:\/\/\S+)/.exec(d.toString());
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const busy = stderr().includes('EADDRINUSE');
      reject(
        new Error(
          busy
            ? `Port ${String(port)} is already in use. Set ORCH_E2E_PORT to a free port, or unset ` +
                'it so this run picks one.'
            : `orch ui exited with ${String(code)}: ${stderr().trim()}`,
        ),
      );
    });
  });
}
