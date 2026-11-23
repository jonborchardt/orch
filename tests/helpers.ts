/** Shared fixtures: temp ORCH_HOME, temp Git repositories, and a CLI runner. */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { installRoot, type RuntimePaths } from '../src/core/paths.ts';
import { openStore, type Store } from '../src/storage/client.ts';

const created: string[] = [];

/**
 * A fresh temp directory by its real path: on Windows the runner's TEMP is an 8.3 alias. Every
 * directory is remembered so tests/setup.ts can remove it when the file finishes, whether or not
 * the test cleaned up itself; a test that wants a directory kept copies it elsewhere.
 */
export function tempDir(prefix = 'orch-test-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Remove every directory this file's tests created through `tempDir`; busy ones are left. */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* an open handle (a store a test never closed) keeps it; nothing else will touch it */
    }
  }
}

/** Remove a directory link, never its target: Windows junctions need rmdir, POSIX symlinks unlink. */
export function removeLink(path: string): void {
  try {
    rmdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOTDIR') throw err;
    unlinkSync(path);
  }
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
  if (/^round-\d+\/simplify-review\.md$/.test(p)) return '# Simplify review\n\n## Findings\nnone\n';
  if (/^round-\d+\/simplify\.md$/.test(p)) {
    return '# Simplify\n\n## Applied\nnone\n\n## Declined\nnone\n\n## Validation\nnpm test: pass\n';
  }
  if (/^round-\d+\/review-/.test(p) || /^spec-review-\d+\.md$/.test(p)) {
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
  // A minimal verification policy, so build/approve/pr gates can be satisfied with `orch verify`.
  commitFile(clone, 'factory.json', NOOP_POLICY, 'add verification policy');
  gitIn(clone, 'push', '-q', '-u', 'origin', 'main');
  return { clone, bare };
}

/** factory.json whose only check is `node -e 0`. */
export const NOOP_POLICY =
  JSON.stringify(
    { verification: { commands: [{ id: 'noop', command: 'node', args: ['-e', '0'] }] } },
    null,
    2,
  ) + '\n';

const main = () => join(installRoot(), 'src', 'cli', 'main.ts');

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
  // Nor its mail settings: only a test's own MAIL_* (pointing at the fake server) reach the CLI.
  for (const key of Object.keys(base))
    if (key.startsWith('MAIL_')) Reflect.deleteProperty(base, key);
  return { ...base, ...env };
}

/** Run the CLI from source in `cwd` with ORCH_HOME pointed at `home`; `input` feeds stdin. */
export function orch(
  home: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): CliResult {
  const r = spawnSync(process.execPath, [main(), ...args], {
    cwd,
    encoding: 'utf8',
    env: cliEnv(home, env),
    input,
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
    const child = spawn(process.execPath, [main(), ...args], { cwd, env: cliEnv(home, env) });
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

/**
 * A stand-in for `gh`, run as `node gh-shim.cjs <args>` via ORCH_GH_SHIM. State (repo, issue,
 * PRs, checks, a command to fail, and the call log) lives in a JSON file tests read and change.
 * With `bare` set to the local origin repository, PR heads are read from it like GitHub would;
 * `gh api` answers come from `checkRuns`/`statuses` (keyed by sha, `*` as default; paginated in
 * pages of 100 under `--paginate --slurp`), `protection`, `rules`, `logs` (keyed by job id), or
 * `api` (keyed by path), `rate_limit` (the recovery worker's probe), else HTTP 404. A PR's
 * `pulls/<n>/files` come from its `files` entries (paginated the same way; a string is printed
 * as is), and its `changedFiles`, unless set, is their count (0 without any). `gh run rerun` succeeds and is only logged; `gh pr ready`
 * takes the PR out of draft; `gh pr merge` sets it MERGED with `mergeOid` as its merge commit.
 * `failAfter` fails a command after it took effect (a timeout that followed a merge).
 */
const GH_SHIM_SOURCE = String.raw`
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const file = process.env.ORCH_GH_SHIM_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const [a, b] = args;
const flag = (f) => args[args.indexOf(f) + 1];
let code = 0;
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const notFound = () => { process.stderr.write('gh: Not Found (HTTP 404)'); code = 1; };
const withHead = (p) => {
  p = { changedFiles: Array.isArray(p.files) ? p.files.length : 0, ...p };
  if (!state.bare) return p;
  try {
    const sha = execFileSync('git', ['rev-parse', 'refs/heads/' + p.headRefName], { cwd: state.bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { ...p, headRefOid: sha };
  } catch { return p; }
};
if (state.fail && (a + ' ' + b).startsWith(state.fail)) { process.stderr.write('shim: simulated failure'); code = 1; }
else if (a === 'repo' && b === 'view') out(state.repo);
else if (a === 'issue' && b === 'view') out(state.issue);
else if (a === 'pr' && b === 'list') out(state.prs.filter((p) => p.headRefName === flag('--head')).map(withHead));
else if (a === 'pr' && b === 'view') {
  const pr = state.prs.find((p) => p.url === args[2] || String(p.number) === args[2]);
  if (!pr) { process.stderr.write('no pull requests found'); code = 1; } else out(withHead(pr));
} else if (a === 'run' && b === 'rerun') {
  out('');
} else if (a === 'pr' && b === 'ready') {
  const pr = state.prs.find((p) => p.url === args[2] || String(p.number) === args[2]);
  if (!pr) { process.stderr.write('no pull requests found'); code = 1; } else { pr.isDraft = false; out(''); }
} else if (a === 'pr' && b === 'merge') {
  const pr = state.prs.find((p) => p.url === args[2] || String(p.number) === args[2]);
  if (!pr) { process.stderr.write('no pull requests found'); code = 1; } else { pr.state = 'MERGED'; pr.mergeCommit = { oid: state.mergeOid || 'c'.repeat(40) }; out(''); }
} else if (a === 'api') {
  const path = b.replace(/^\//, '').split('?')[0];
  // --paginate --slurp: pages of 100, returned as one array, like gh does.
  const slurp = args.includes('--slurp');
  const paged = (items, wrap) => {
    const pages = [];
    for (let i = 0; i < Math.max(items.length, 1); i += 100) pages.push(wrap(items.slice(i, i + 100)));
    out(slurp ? pages : pages[0]);
  };
  let m;
  if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files$/.exec(path))) {
    const pr = state.prs.find((p) => String(p.number) === m[1]);
    const files = (pr && pr.files) || [];
    if (typeof files === 'string') out(files); else paged(files, (page) => page);
  } else if ((m = /\/commits\/([0-9a-f]+)\/check-runs$/.exec(path))) {
    const runs = (state.checkRuns || {})[m[1]] || (state.checkRuns || {})['*'] || [];
    paged(runs, (page) => ({ total_count: runs.length, check_runs: page }));
  } else if ((m = /\/commits\/([0-9a-f]+)\/status$/.exec(path))) {
    const statuses = (state.statuses || {})[m[1]] || (state.statuses || {})['*'] || [];
    paged(statuses, (page) => ({ state: statuses.some((s) => s.state !== 'success') ? 'pending' : 'success', statuses: page }));
  } else if (/\/protection\/required_status_checks$/.test(path)) {
    if (state.protection) out(state.protection); else notFound();
  } else if (/\/rules\/branches\//.test(path)) out(state.rules || []);
  else if ((m = /\/actions\/jobs\/(\d+)\/logs$/.exec(path))) {
    const log = (state.logs || {})[m[1]];
    if (log === undefined) notFound(); else out(log);
  } else if (state.api && state.api[path] !== undefined) out(state.api[path]);
  else if (path === 'rate_limit') out({ resources: {} });
  else notFound();
} else if (a === 'pr' && b === 'create') {
  const n = state.prs.length + 1;
  state.prs.push({
    number: n, url: state.repo.url + '/pull/' + n, state: 'OPEN',
    isDraft: args.includes('--draft'), baseRefName: flag('--base'), headRefName: flag('--head'),
    title: flag('--title'), mergeable: 'MERGEABLE', statusCheckRollup: state.checks,
    body: fs.readFileSync(flag('--body-file'), 'utf8'),
  });
  out(state.repo.url + '/pull/' + n + '\n');
} else { process.stderr.write('shim: unknown command ' + args.join(' ')); code = 1; }
if (state.failAfter && (a + ' ' + b).startsWith(state.failAfter)) { process.stderr.write('shim: timed out'); code = 1; }
fs.writeFileSync(file, JSON.stringify(state));
process.exit(code);
`;

export interface ShimCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  app?: { slug: string };
  /** Workflow run the job belongs to; attempts of one check share it. */
  check_suite?: { id: number };
}

export interface ShimState {
  calls: string[][];
  /** Fail every command whose first two words start with this (e.g. "repo view", "api repos/"). */
  fail?: string | undefined;
  /** Like `fail`, but the command takes effect first. */
  failAfter?: string | undefined;
  /** Merge commit `gh pr merge` gives the PR (default: forty `c`). */
  mergeOid?: string | undefined;
  repo: { nameWithOwner: string; url: string; defaultBranchRef: { name: string } | null };
  issue: Record<string, unknown>;
  prs: Record<string, unknown>[];
  checks: Record<string, unknown>[];
  /** Local bare origin; when set, PR heads are resolved from its branches. */
  bare?: string | undefined;
  /** Check runs per commit sha (`*` = any sha). */
  checkRuns?: Record<string, ShimCheckRun[]> | undefined;
  /** Commit statuses per sha (`*` = any sha). */
  statuses?: Record<string, { context: string; state: string; target_url?: string }[]> | undefined;
  /** Classic branch protection required checks; null/absent = HTTP 404. */
  protection?: { contexts?: string[]; checks?: { context: string }[] } | null | undefined;
  rules?: Record<string, unknown>[] | undefined;
  /** Actions job logs by job id. */
  logs?: Record<string, string> | undefined;
  /** Any other `gh api <path>` answer by path (query string stripped). */
  api?: Record<string, unknown> | undefined;
}

export interface GhShim {
  dir: string;
  stateFile: string;
  /** Environment for `orch(...)` or `process.env` so `gh` resolves to the shim. */
  env: Record<string, string>;
  read(): ShimState;
  write(patch: Partial<ShimState>): void;
  reset(repo?: string): void;
  cleanup(): void;
}

/** Create a shim for GitHub repository `repo` (owner/name). */
export function ghShim(repo = 'acme/alpha'): GhShim {
  const dir = tempDir('orch-gh-shim-');
  const stateFile = join(dir, 'state.json');
  const script = join(dir, 'gh-shim.cjs');
  writeFileSync(script, GH_SHIM_SOURCE);
  const shim: GhShim = {
    dir,
    stateFile,
    env: { ORCH_GH_SHIM: script, ORCH_GH_SHIM_STATE: stateFile },
    read: () => JSON.parse(readFileSync(stateFile, 'utf8')) as ShimState,
    write: (patch) => {
      writeFileSync(stateFile, JSON.stringify({ ...shim.read(), ...patch }));
    },
    reset: (r = repo) => {
      writeFileSync(
        stateFile,
        JSON.stringify({
          calls: [],
          repo: {
            nameWithOwner: r,
            url: `https://github.com/${r}`,
            defaultBranchRef: { name: 'main' },
          },
          issue: {
            number: 12,
            title: 'Export CSV',
            body: 'Please',
            url: `https://github.com/${r}/issues/12`,
            state: 'OPEN',
            labels: [{ name: 'feature' }],
          },
          prs: [],
          checks: [],
        } satisfies ShimState),
      );
    },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  shim.reset();
  return shim;
}
