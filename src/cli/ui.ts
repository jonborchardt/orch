/** `orch ui`: the one long-running command. Serves the dashboard on loopback until Ctrl+C. */
import { spawn } from 'node:child_process';

import { UsageError } from '../core/errors.ts';
import { webDistDir } from '../core/paths.ts';
import { DEFAULT_PORT, startServer } from '../server/http.ts';
import { openStore } from '../storage/client.ts';

export interface UiOptions {
  port?: string;
  open?: boolean;
}

export const UI_HELP = `Usage: orch ui [--port <n>] [--open]

Starts the local factory dashboard at http://127.0.0.1:${String(DEFAULT_PORT)}/ (loopback only)
and keeps running until interrupted. It reads the shared database and the job artifacts; its
actions (approve, request review/rework, cancel) use the same validated workflow operations as
the CLI and never pretend to wake a Claude session. Factory jobs do not need it to be running.
`;

function openBrowser(url: string): void {
  const [exe, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(exe, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no browser available; the URL was printed */
  }
}

export async function runUi(o: UiOptions): Promise<number> {
  let port = DEFAULT_PORT;
  if (o.port !== undefined) {
    port = Number(o.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError('--port must be an integer from 0 to 65535 (0 picks a free port)');
    }
  }
  const store = openStore();
  const running = await startServer({ store, port });
  console.log(`orch dashboard: ${running.url}`);
  console.log(`database: ${store.file}`);
  console.log(`assets: ${webDistDir()}`);
  console.log('Press Ctrl+C to stop.');
  if (o.open) openBrowser(running.url);
  await new Promise<void>((done) => {
    const stop = () => {
      running
        .close()
        .catch(() => undefined)
        .finally(() => {
          store.close();
          done();
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    // Windows consoles deliver Ctrl+C as SIGINT; a closed stdin also stops us when run as a child.
    process.stdin.on('end', stop);
    process.stdin.resume();
  });
  return 0;
}
