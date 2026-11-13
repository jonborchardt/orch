/** Shared fixtures: temp ORCH_HOME, temp Git repositories, and a CLI runner. */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { installRoot, type RuntimePaths } from '../src/core/paths.ts';
import { openStore, type Store } from '../src/storage/client.ts';

export function tempDir(prefix = 'orch-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function homePaths(home: string): RuntimePaths {
  return { config: home, data: home, logs: join(home, 'logs'), tmp: join(home, 'tmp') };
}

export interface TempStore extends Store {
  home: string;
  cleanup(): void;
}

/** Store backed by a fresh temp directory. `cleanup()` closes it and removes the directory. */
export function tempStore(): TempStore {
  const home = tempDir();
  const store = openStore(homePaths(home));
  return {
    ...store,
    home,
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Write a non-empty Markdown artifact file relative to `dir`. */
export function writeArtifact(dir: string, rel: string, body = '# ok\n'): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/** Initialize a Git repository with one commit on `main` and an optional origin URL. */
export function makeRepo(origin?: string): string {
  const dir = tempDir('orch-repo-');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'ignore', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git('remote', 'add', 'origin', origin);
  return dir;
}

const MAIN = join(installRoot(), 'src', 'cli', 'main.ts');

export interface CliResult {
  code: number | null;
  out: string;
  err: string;
}

function cliEnv(home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, ORCH_HOME: home };
  // Never inherit a real session's credentials into tests.
  delete base['ORCH_TOKEN'];
  delete base['ORCH_SESSION'];
  return { ...base, ...env };
}

/** Run the CLI from source in `cwd` with ORCH_HOME pointed at `home`. */
export function orch(
  home: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): CliResult {
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: cliEnv(home, env),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Async variant for launching several invocations at the same time. */
export function orchAsync(
  home: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd, env: cliEnv(home, env) });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => {
      resolve({ code, out, err });
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller picks the shape
export function json<T = Record<string, unknown>>(r: CliResult): T {
  try {
    return JSON.parse(r.out) as T;
  } catch {
    throw new Error(`CLI printed no JSON (exit ${String(r.code)}): ${r.err}`);
  }
}
