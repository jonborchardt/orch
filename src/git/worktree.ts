/**
 * Git worktree operations with argument arrays. These touch Git only; recording the result in
 * the database happens in src/ops/worktree.ts.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { MergeConflictError, ToolError } from '../core/errors.ts';
import { baseRef, canonicalPath, dirtyFiles, refExists, sameRepository } from './repo.ts';
import { git, tryGit } from './run.ts';

export interface Commit {
  sha: string;
  subject: string;
}

export interface WorktreeInfo {
  path: string;
  exists: boolean;
  /** `path` is itself the top level of a working tree of the same repository. */
  isWorktree: boolean;
  branch: string | null;
  head: string | null;
  /** Files with uncommitted changes (staged, unstaged, or untracked). */
  dirty: string[];
  /** Ref the branch is compared against: origin/<base> when present, else the local base. */
  baseRef: string | null;
  ahead: number | null;
  behind: number | null;
  /** Commits on the branch that are not on the base, newest first. */
  commits: Commit[];
  /** Files changed by those commits relative to the merge base. */
  changedFiles: string[];
  /** The same files with their change status. */
  changes: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }[];
}

const STATUS: Record<string, 'added' | 'modified' | 'deleted' | 'renamed'> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  T: 'modified',
};

/** Parse `git diff --name-status` output (renames report the new path). */
export function parseNameStatus(out: string): WorktreeInfo['changes'] {
  if (!out) return [];
  return out.split(/\r?\n/).flatMap((line) => {
    const [code = '', ...paths] = line.split('\t');
    const status = STATUS[code.charAt(0)];
    const path = paths[paths.length - 1];
    return status && path ? [{ path, status }] : [];
  });
}

/** Read-only description of `path` as a candidate worktree of `repoRoot`. */
export function inspectWorktree(repoRoot: string, path: string, baseBranch: string): WorktreeInfo {
  const info: WorktreeInfo = {
    path,
    exists: existsSync(path),
    isWorktree: false,
    branch: null,
    head: null,
    dirty: [],
    baseRef: null,
    ahead: null,
    behind: null,
    commits: [],
    changedFiles: [],
    changes: [],
  };
  if (!info.exists) return info;
  const top = tryGit(path, 'rev-parse', '--show-toplevel');
  if (!top || canonicalPath(top) !== canonicalPath(path) || !sameRepository(repoRoot, path)) {
    return info;
  }
  info.isWorktree = true;
  info.head = tryGit(path, 'rev-parse', 'HEAD') ?? null;
  const branch = tryGit(path, 'rev-parse', '--abbrev-ref', 'HEAD');
  info.branch = branch && branch !== 'HEAD' ? branch : null;
  info.dirty = dirtyFiles(path);
  const base = baseRef(repoRoot, baseBranch);
  if (base && info.head) {
    info.baseRef = base;
    const counts = tryGit(path, 'rev-list', '--left-right', '--count', `${base}...HEAD`);
    if (counts) {
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      info.behind = behind ?? null;
      info.ahead = ahead ?? null;
    }
    const log = tryGit(path, 'log', '--format=%H%x09%s', `${base}..HEAD`);
    info.commits = log
      ? log.split(/\r?\n/).map((l) => {
          const [sha = '', ...rest] = l.split('\t');
          return { sha, subject: rest.join('\t') };
        })
      : [];
    info.changes = parseNameStatus(tryGit(path, 'diff', '--name-status', `${base}...HEAD`) ?? '');
    info.changedFiles = info.changes.map((c) => c.path);
  }
  return info;
}

/**
 * Files in merge commit `sha` whose result matches neither parent: conflict resolutions or edits
 * made while committing the merge. Empty for a clean automatic merge (`git diff-tree --cc`
 * drops every hunk that simply took one side).
 */
export function mergeEdits(path: string, sha: string): string[] {
  const parents = tryGit(path, 'rev-list', '--parents', '-n', '1', sha)?.split(/\s+/) ?? [];
  if (parents.length < 3) return [];
  const out = tryGit(path, 'diff-tree', '--cc', '-p', sha) ?? '';
  const files = new Set<string>();
  for (const m of out.matchAll(/^diff --(?:cc|combined) (.+)$/gm)) files.add(m[1] ?? '');
  files.delete('');
  return [...files].sort();
}

/** Merge commits between `from` (exclusive) and `to` with edits that match neither parent. */
export function editedMerges(
  path: string,
  from: string,
  to: string,
): { sha: string; files: string[] }[] {
  const list = tryGit(path, 'rev-list', '--merges', `${from}..${to}`) ?? '';
  return list
    .split(/\r?\n/)
    .filter(Boolean)
    .map((sha) => ({ sha, files: mergeEdits(path, sha) }))
    .filter((m) => m.files.length > 0);
}

/**
 * Create a worktree at `path` on `branch`. The branch is created from the base when it does not
 * exist yet; an existing branch (from an earlier attempt) is checked out as is.
 */
export function addWorktree(
  repoRoot: string,
  path: string,
  branch: string,
  baseBranch: string,
): void {
  tryGit(repoRoot, 'worktree', 'prune');
  mkdirSync(dirname(path), { recursive: true });
  if (refExists(repoRoot, `refs/heads/${branch}`)) {
    git(repoRoot, 'worktree', 'add', path, branch);
    return;
  }
  const base = baseRef(repoRoot, baseBranch);
  if (!base) {
    throw new ToolError(`Base branch ${baseBranch} not found in ${repoRoot} (local or origin).`);
  }
  git(repoRoot, 'worktree', 'add', '-b', branch, path, base);
}

/** Remove a worktree directory and its registration. Callers check for uncommitted work first. */
export function removeWorktree(repoRoot: string, path: string, force = false): void {
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  git(repoRoot, ...args);
}

export function pruneWorktrees(repoRoot: string): void {
  tryGit(repoRoot, 'worktree', 'prune');
}

export interface MergeResult {
  merged: boolean;
  /** True when the branch already contained the base. */
  upToDate: boolean;
  head: string;
}

/**
 * Merge `ref` into the worktree's branch. On conflict the merge is aborted, the worktree is
 * left as it was, and a MergeConflictError names the conflicting files.
 */
export function mergeInto(path: string, ref: string): MergeResult {
  const before = git(path, 'rev-parse', 'HEAD');
  try {
    git(path, 'merge', '--no-edit', '--no-ff', ref);
  } catch (err) {
    const conflicts = tryGit(path, 'diff', '--name-only', '--diff-filter=U') ?? '';
    tryGit(path, 'merge', '--abort');
    const files = conflicts ? conflicts.split(/\r?\n/) : [];
    throw new MergeConflictError(ref, files, (err as Error).message);
  }
  const after = git(path, 'rev-parse', 'HEAD');
  return { merged: after !== before, upToDate: after === before, head: after };
}

/** Commits reachable from `ref` and merged into the base. */
export function containsRef(path: string, ref: string, target: string): boolean {
  return tryGit(path, 'merge-base', '--is-ancestor', ref, target) !== undefined;
}
