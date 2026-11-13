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

/**
 * Minimal content satisfying core/artifact-rules.ts for a workflow artifact path. `marker`
 * overrides the default verdict / decision / blocking count.
 */
export function fixture(rel: string, marker?: string): string {
  const p = rel.split('\\').join('/');
  if (p === 'spec.md') {
    return '# Spec\n\n## Goal\nG\n\n## Scope\nS\n\n## Acceptance criteria\n- [ ] a\n';
  }
  if (p === 'build.md') return '# Build\n\n## Summary\nS\n\n## Validation\nnpm test: pass\n';
  if (/^round-\d+\/review-/.test(p)) {
    return `# Review\n\n## Findings\nnone\n\nVERDICT: ${marker ?? 'PASS'}\n`;
  }
  if (/^round-\d+\/consolidated\.md$/.test(p)) {
    return `# Consolidated\n\n## Findings\nnone\n\nBLOCKING: ${marker ?? '0'}\n`;
  }
  if (p === 'decision.md') {
    return `# Decision\n\n## Rationale\nok\n\nDECISION: ${marker ?? 'APPROVE'}\n`;
  }
  if (p === 'pr.md') return '# PR\n\n## Validation\nok\n\n## Known limitations\nnone\n';
  return '# ok\n';
}

/** Write a rule-compliant Markdown artifact file relative to `dir` (or the given body). */
export function writeArtifact(dir: string, rel: string, body = fixture(rel)): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

/** Run git in `cwd`, returning trimmed stdout. */
export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

/** Initialize a Git repository with one commit on `main` and an optional origin URL. */
export function makeRepo(origin?: string, dir = tempDir('orch-repo-')): string {
  const git = (...args: string[]) => gitIn(dir, ...args);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git('remote', 'add', 'origin', origin);
  return dir;
}

/** Commit a file in `repo` (or a worktree) and return the new HEAD sha. */
export function commitFile(
  repo: string,
  rel: string,
  body: string,
  message = `add ${rel}`,
): string {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  gitIn(repo, 'add', '--', rel);
  gitIn(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
  return gitIn(repo, 'rev-parse', 'HEAD');
}

/**
 * A clone whose `origin` URL is `originUrl` (so the repository identity looks like GitHub) while
 * fetches and pushes actually go to a local bare repository via `url.<bare>.insteadOf`.
 */
export function makeRepoWithOrigin(
  originUrl = 'git@github.com:acme/alpha.git',
  dir = tempDir('orch-repo-'),
): { clone: string; bare: string } {
  const bare = tempDir('orch-bare-');
  gitIn(bare, 'init', '-q', '--bare', '-b', 'main');
  const clone = makeRepo(originUrl, dir);
  gitIn(clone, 'config', `url.${bare.split('\\').join('/')}.insteadOf`, originUrl);
  gitIn(clone, 'push', '-q', '-u', 'origin', 'main');
  return { clone, bare };
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
