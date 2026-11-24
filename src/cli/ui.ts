/** `orch ui`: the one long-running command. Serves the dashboard on loopback until Ctrl+C. */
import { spawn } from 'node:child_process';
import { constants, fstatSync } from 'node:fs';
import { isatty } from 'node:tty';

import { UsageError } from '../core/errors.ts';
import { DEFAULT_PORT, webDistDir } from '../core/paths.ts';
import { startServer } from '../server/http.ts';
import { openStore } from '../storage/client.ts';

export interface UiOptions {
  port?: string;
  open?: boolean;
}

export const UI_HELP = `Usage: orch ui [--port <n>] [--open]

Starts the local factory dashboard at http://127.0.0.1:${String(DEFAULT_PORT)}/ (loopback only)
and keeps running until interrupted (Ctrl+C, SIGINT, SIGTERM, or a parent closing a piped stdin;
a closed or null stdin is ignored, so a script or task can launch it). It reads the shared database and the job artifacts; its
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

/**
 * Whether a closed stdin should stop the server: only a terminal or a pipe/socket a parent holds.
 * The null device, a file, or a closed or invalid fd 0 reaches end at once, so it is ignored
 * (ticket 0094). Mode bits, not `isFIFO()`, which reports false for a Windows pipe.
 */
function stdinOwnsLifetime(): boolean {
  try {
    if (isatty(0)) return true;
    const type = fstatSync(0).mode & constants.S_IFMT;
    return type === constants.S_IFIFO || type === constants.S_IFSOCK;
  } catch {
    return false;
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
    let stopping = false;
    const stop = () => {
      // Ctrl+C after stdin closed (or both signals) must not close the store twice.
      if (stopping) return;
      stopping = true;
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
    if (stdinOwnsLifetime()) {
      process.stdin.on('end', stop);
      process.stdin.resume();
    }
  });
  return 0;
}
