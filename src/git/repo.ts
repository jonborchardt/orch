/** Read-only Git queries. Direct execution with argument arrays; no shell. */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { findProjectRoot } from '../core/paths.ts';

export interface RepoInfo {
  root: string;
  /** Stable identity shared by all clones: normalized origin URL, else the directory name. */
  identity: string;
  currentBranch: string;
}

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
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
  const remote = git(root, 'remote', 'get-url', 'origin');
  return {
    root,
    identity: remote ? normalizeRemote(remote) : basename(root).toLowerCase(),
    currentBranch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD') ?? 'HEAD',
  };
}
