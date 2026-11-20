/** Read-only Git queries. Direct execution with argument arrays; no shell. */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { ToolError, ValidationError } from '../core/errors.ts';
import { spawnTool } from '../core/exec.ts';
import { canonicalPath, findProjectRoot } from '../core/paths.ts';
import { git, tryGit } from './run.ts';

export interface RepoInfo {
  root: string;
  /** Remote identity shared by all clones: normalized origin URL, else the directory name. */
  identity: string;
  /** The normalized origin URL, undefined when the checkout has no `origin`. */
  remote: string | undefined;
  currentBranch: string;
}

/** e.g. git@github.com:org/repo.git and https://github.com/org/repo -> github.com/org/repo */
export function normalizeRemote(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@]+@/, '')
    .replace(/:(?=[^/])/, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function describeRepo(cwd: string): RepoInfo {
  const root = findProjectRoot(cwd);
  if (!root)
    throw new ValidationError(`${cwd} is not inside a Git repository (use --repo <path>).`);
  // The configured URL, not `remote get-url`, which applies url.<base>.insteadOf rewrites.
  const url = tryGit(root, 'config', '--get', 'remote.origin.url');
  const remote = url ? normalizeRemote(url) : undefined;
  return {
    root,
    identity: remote ?? basename(root).toLowerCase(),
    remote,
    currentBranch: tryGit(root, 'rev-parse', '--abbrev-ref', 'HEAD') ?? 'HEAD',
  };
}

/** The shared `.git` directory of a checkout or worktree, resolved to an absolute real path. */
export function commonGitDir(cwd: string): string {
  return canonicalPath(resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir')));
}

export interface CheckoutIdentity {
  /** Canonical Git directory: `.git` for the primary checkout, `.git/worktrees/<n>` for a linked one. */
  key: string;
  /** Top level of the working tree, as Git reports it. */
  root: string;
  /** Canonical common directory shared by the checkout and all its linked worktrees. */
  commonDir: string;
  kind: 'primary' | 'worktree';
}

/**
 * Identify the checkout containing `path` (a file, a directory, or a path that does not exist
 * yet, resolved through its nearest existing ancestor). Every checkout has its own Git directory,
 * so two worktrees of one repository get distinct keys while two spellings of one checkout get
 * the same one; two unrelated repositories never share a key however their directories are named.
 * Undefined when `path` is not inside a Git repository.
 */
export function checkoutIdentity(path: string): CheckoutIdentity | undefined {
  let probe = resolve(path);
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return undefined;
    probe = parent;
  }
  if (!statSync(probe).isDirectory()) probe = dirname(probe);
  const root = findProjectRoot(probe);
  if (!root) return undefined;
  const gitDir = tryGit(root, 'rev-parse', '--absolute-git-dir');
  if (!gitDir) return undefined;
  const key = canonicalPath(gitDir);
  const commonDir = commonGitDir(root);
  return { key, root, commonDir, kind: key === commonDir ? 'primary' : 'worktree' };
}

/**
 * Root of the primary checkout of the repository containing `cwd` (itself, or the checkout a
 * linked worktree belongs to): the first entry of `git worktree list`, which also holds when the
 * common directory is not `<primary>/.git`. A bare repository has no primary checkout.
 */
export function primaryCheckout(cwd: string): string {
  const first = git(cwd, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/)[0] ?? '';
  const lines = first.split(/\r?\n/);
  const path = lines[0]?.startsWith('worktree ') ? lines[0].slice('worktree '.length) : undefined;
  if (path === undefined || lines.includes('bare')) {
    throw new ValidationError(
      `${cwd} belongs to a bare repository, which has no primary checkout; pass --repo <a checkout>.`,
    );
  }
  return resolve(path);
}

/** Paths with uncommitted changes (staged, unstaged, untracked). Empty when clean. */
export function dirtyFiles(cwd: string): string[] {
  // Raw stdout, not `git()`: that trims, so a first line like " M path" would lose its leading
  // space and then the first character of the path.
  const r = spawnTool('git', ['status', '--porcelain', '--untracked-files=all'], { cwd });
  if (r.status !== 0) throw new ToolError(`git status failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3));
}

export function remoteExists(repoRoot: string, name = 'origin'): boolean {
  return tryGit(repoRoot, 'remote', 'get-url', name) !== undefined;
}

/**
 * `git fetch origin <branch>` in `cwd`, bounded so a hung remote or a credential prompt cannot
 * stall the caller. Null on success, else the first stderr line (or the timeout).
 */
export function fetchBase(cwd: string, branch: string, timeoutMs = 15_000): string | null {
  const r = spawnTool('git', ['fetch', '--quiet', 'origin', branch], {
    cwd,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status === 0) return null;
  if (r.timedOut) return `timed out after ${String(timeoutMs / 1000)} s`;
  const first = r.stderr.trim().split(/\r?\n/)[0] ?? '';
  return first === '' ? `git fetch exited ${String(r.status)}` : first;
}

export function refExists(repoRoot: string, ref: string): boolean {
  return tryGit(repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== undefined;
}

/** `origin/<branch>` when it exists, else the local branch, else undefined. */
export function baseRef(repoRoot: string, branch: string): string | undefined {
  if (refExists(repoRoot, `refs/remotes/origin/${branch}`)) return `origin/${branch}`;
  if (refExists(repoRoot, `refs/heads/${branch}`)) return branch;
  return undefined;
}
