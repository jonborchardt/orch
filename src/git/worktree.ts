/**
 * Git worktree operations with argument arrays. These touch Git only; recording the result in
 * the database happens in src/ops/worktree.ts.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { MergeConflictError, ToolError } from '../core/errors.ts';
import { canonicalPath } from '../core/paths.ts';
import { baseRef, commonGitDir, dirtyFiles, refExists } from './repo.ts';
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
  /**
   * Why `isWorktree` is false or `head` is null for an existing path: the failing step and Git's
   * error. Diagnostic only; never part of the fingerprint.
   */
  problem?: string;
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

/** Commits in `from..to`, newest first; null when Git cannot resolve either commit. */
export function commitsBetween(path: string, from: string, to: string): Commit[] | null {
  const log = tryGit(path, 'log', '--format=%H%x09%s', `${from}..${to}`, '--');
  if (log === undefined) return null;
  return (log ? log.split(/\r?\n/) : []).map((l) => {
    const [sha = '', ...rest] = l.split('\t');
    return { sha, subject: rest.join('\t') };
  });
}

/** Files `to` changed since its merge base with `from`; null when Git cannot resolve either. */
export function changesBetween(
  path: string,
  from: string,
  to: string,
): WorktreeInfo['changes'] | null {
  const out = tryGit(path, 'diff', '--name-status', `${from}...${to}`, '--');
  return out === undefined ? null : parseNameStatus(out);
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
  // Each step records its failure in `info.problem` instead of throwing, so callers that only
  // need "is it a worktree?" behave as before while check-readonly can say why it is not.
  const step = <T>(name: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      info.problem ??= `${name}: ${(err as Error).message}`;
      return undefined;
    }
  };
  // One rev-parse answers several questions, one line per argument in order: every gate inspects
  // the worktree, and on Windows each Git process costs tens of milliseconds. HEAD and its branch
  // come along when HEAD exists; an unborn branch fails that call, so the steps run one by one.
  const all = tryGit(
    path,
    'rev-parse',
    '--show-toplevel',
    '--git-common-dir',
    'HEAD',
    '--abbrev-ref',
    'HEAD',
  )?.split(/\r?\n/);
  const ids =
    all?.length === 4
      ? all
      : step('rev-parse --show-toplevel', () =>
          git(path, 'rev-parse', '--show-toplevel', '--git-common-dir').split(/\r?\n/),
        );
  const top = ids?.[0];
  if (!top) return info;
  if (canonicalPath(top) !== canonicalPath(path)) {
    info.problem = `rev-parse --show-toplevel: git reports ${canonicalPath(top)}, expected ${canonicalPath(path)}`;
    return info;
  }
  // The repository's common dir and its origin/<base> commit in one call when origin has the
  // base (the usual case); otherwise each is looked up on its own as before.
  const root = tryGit(
    repoRoot,
    'rev-parse',
    '--git-common-dir',
    `refs/remotes/origin/${baseBranch}^{commit}`,
  )?.split(/\r?\n/);
  const rootShared = root?.length === 2 && root[0] ? root[0] : undefined;
  const ours =
    rootShared !== undefined
      ? canonicalPath(resolve(repoRoot, rootShared))
      : step('rev-parse --git-common-dir in the repository', () => commonGitDir(repoRoot));
  const theirs = canonicalPath(resolve(path, ids[1] ?? ''));
  if (ours === undefined) return info;
  if (ours !== theirs) {
    info.problem = `rev-parse --git-common-dir: ${theirs} belongs to another repository than ${ours}`;
    return info;
  }
  info.isWorktree = true;
  // HEAD and its branch name together; both fail together on an unborn branch (head stays null).
  const [head, branch] =
    all?.length === 4
      ? all.slice(2)
      : (step('rev-parse HEAD', () =>
          git(path, 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'),
        )?.split(/\r?\n/) ?? []);
  info.head = head ?? null;
  info.branch = branch && branch !== 'HEAD' ? branch : null;
  info.dirty = dirtyFiles(path);
  const base = rootShared !== undefined ? `origin/${baseBranch}` : baseRef(repoRoot, baseBranch);
  if (base && info.head) {
    info.baseRef = base;
    // One walk of the symmetric difference: `<` marks base-only commits (behind), `>` the job's
    // own (ahead, listed newest first exactly as `git log base..HEAD` lists them).
    const log = tryGit(path, 'log', '--left-right', '--format=%m%H%x09%s', `${base}...HEAD`);
    if (log !== undefined) {
      const lines = log ? log.split(/\r?\n/) : [];
      const own = lines.filter((l) => l.startsWith('>'));
      info.behind = lines.length - own.length;
      info.ahead = own.length;
      info.commits = own.map((l) => {
        const [sha = '', ...rest] = l.slice(1).split('\t');
        return { sha, subject: rest.join('\t') };
      });
    }
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

/**
 * Merge commits between `from` (exclusive) and `to` with edits that match neither parent. Merges
 * already reachable from `base` came in with the base branch and are not this branch's code.
 */
export function editedMerges(
  path: string,
  from: string,
  to: string,
  base?: string,
): { sha: string; files: string[] }[] {
  const range = [`${from}..${to}`, ...(base ? [`^${base}`] : [])];
  const list = tryGit(path, 'rev-list', '--merges', ...range) ?? '';
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
