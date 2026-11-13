/**
 * Job worktree operations: Git actions plus the matching database record, with ownership
 * checked before anything touches disk. Nothing here deletes uncommitted work.
 */
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { jobWorktreeDir } from '../core/paths.ts';
import { describeRepo, remoteExists, baseRef } from '../git/repo.ts';
import { git } from '../git/run.ts';
import {
  addWorktree,
  inspectWorktree,
  mergeInto,
  pruneWorktrees,
  removeWorktree,
  type MergeResult,
  type WorktreeInfo,
} from '../git/worktree.ts';
import type { Store } from '../storage/client.ts';
import {
  type Auth,
  authorize,
  clearWorktree,
  getJob,
  recordEvent,
  setWorktree,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';

export interface WorktreeResult {
  job: Job;
  worktree: WorktreeInfo;
  /** True when this call created the worktree (false when it already existed). */
  created?: boolean;
}

/** Branch name for a job: factory/<id>-<title slug>. */
export function jobBranch(job: Pick<Job, 'id' | 'title'>): string {
  const slug = job.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug ? `factory/${job.id}-${slug}` : `factory/${job.id}`;
}

/** The clone to operate on; validated to be the job's repository. */
function repoRoot(job: Job, override?: string): string {
  const candidate = override ?? job.repoPath;
  if (!existsSync(candidate)) {
    throw new ValidationError(
      `Repository checkout ${candidate} does not exist. Pass --repo <path> to another clone of ${job.repo}.`,
    );
  }
  const info = describeRepo(candidate);
  if (info.identity !== job.repo) {
    throw new ValidationError(
      `Repository at ${info.root} is ${info.identity}; job ${job.id} belongs to ${job.repo}.`,
    );
  }
  return info.root;
}

/** Read-only view of the job's worktree (or of where it would be created). */
export function showWorktree(store: Store, id: string): WorktreeResult {
  const job = getJob(store.db, id);
  const path = job.worktreePath ?? jobWorktreeDir(job.id, job.repo, store.paths);
  const root = existsSync(job.repoPath) ? job.repoPath : undefined;
  const worktree = root
    ? inspectWorktree(root, path, job.baseBranch)
    : { ...inspectWorktree(path, path, job.baseBranch), isWorktree: false };
  return { job, worktree };
}

/** Create the job's isolated worktree and branch, or return the existing one. */
export function createWorktree(
  store: Store,
  id: string,
  auth: Auth,
  opts: { repo?: string | undefined } = {},
): WorktreeResult {
  let job = authorize(store, id, auth);
  const root = repoRoot(job, opts.repo);
  const path = job.worktreePath ?? jobWorktreeDir(job.id, job.repo, store.paths);
  const branch = job.branch ?? jobBranch(job);
  const existing = inspectWorktree(root, path, job.baseBranch);
  if (existing.exists) {
    if (!existing.isWorktree) {
      throw new ValidationError(
        `${path} exists but is not a worktree of ${job.repo}. Move it aside or adopt a different path.`,
      );
    }
    if (existing.branch !== branch) {
      throw new ValidationError(
        `${path} is on branch ${existing.branch ?? '(detached)'}, expected ${branch}.`,
      );
    }
    if (job.worktreePath !== path || job.branch !== branch || root !== job.repoPath) {
      job = setWorktree(store, id, { ...auth, path, branch, how: 'adopted', repoPath: root });
    }
    return { job, worktree: existing, created: false };
  }
  addWorktree(root, path, branch, job.baseBranch);
  try {
    job = setWorktree(store, id, {
      ...auth,
      path,
      branch,
      how: 'created',
      repoPath: root === job.repoPath ? undefined : root,
    });
  } catch (err) {
    // A brand-new worktree has no work in it; undo so a retry starts clean.
    try {
      removeWorktree(root, path, true);
    } catch {
      /* leave it for inspection */
    }
    throw err;
  }
  return { job, worktree: inspectWorktree(root, path, job.baseBranch), created: true };
}

/** Record an existing worktree directory (same repository, on a branch) as the job's. */
export function adoptWorktree(
  store: Store,
  id: string,
  auth: Auth,
  dir: string,
  opts: { repo?: string | undefined } = {},
): WorktreeResult {
  const job = authorize(store, id, auth);
  const root = repoRoot(job, opts.repo);
  const path = resolve(dir);
  const info = inspectWorktree(root, path, job.baseBranch);
  if (!info.exists) throw new ValidationError(`${path} does not exist.`);
  if (!info.isWorktree) throw new ValidationError(`${path} is not a worktree of ${job.repo}.`);
  if (resolve(root) === path || path.startsWith(resolve(root) + sep)) {
    throw new ValidationError(
      'The primary checkout (or a directory inside it) cannot be a job worktree.',
    );
  }
  if (!info.branch) throw new ValidationError(`${path} is detached; check out a branch first.`);
  if (info.branch === job.baseBranch) {
    throw new ValidationError(
      `${path} is on the base branch ${job.baseBranch}; jobs never work on it.`,
    );
  }
  const updated = setWorktree(store, id, {
    ...auth,
    path,
    branch: info.branch,
    how: 'adopted',
    repoPath: root === job.repoPath ? undefined : root,
  });
  return { job: updated, worktree: info };
}

/**
 * Remove the job's worktree directory. Refused while it has uncommitted changes; the branch and
 * its commits are always kept. A worktree already gone from disk is simply forgotten.
 */
export function dropWorktree(store: Store, id: string, auth: Auth): WorktreeResult {
  const job = authorize(store, id, auth);
  if (!job.worktreePath) throw new ValidationError(`Job ${id} has no worktree.`);
  const root = repoRoot(job);
  const info = inspectWorktree(root, job.worktreePath, job.baseBranch);
  if (!info.exists) {
    pruneWorktrees(root);
    return { job: clearWorktree(store, id, auth, 'missing'), worktree: info };
  }
  if (!info.isWorktree) {
    throw new ValidationError(
      `${job.worktreePath} is not a worktree of ${job.repo}; not removing.`,
    );
  }
  if (info.dirty.length > 0) {
    throw new ValidationError(
      `Worktree has uncommitted changes (${info.dirty.slice(0, 5).join(', ')}${info.dirty.length > 5 ? ', ...' : ''}). ` +
        'Commit or stash them first; orch never deletes uncommitted work.',
    );
  }
  removeWorktree(root, job.worktreePath);
  return { job: clearWorktree(store, id, auth, 'removed'), worktree: { ...info, exists: false } };
}

export interface IntegrateResult extends WorktreeResult {
  merge: MergeResult;
  fetched: boolean;
}

/**
 * Bring base-branch changes into the job branch with a merge commit. Fetches origin first when
 * there is one. Refused on a dirty worktree; conflicts abort the merge and raise an error.
 */
export function integrateBase(store: Store, id: string, auth: Auth): IntegrateResult {
  const job = authorize(store, id, auth);
  if (!job.worktreePath) throw new ValidationError(`Job ${id} has no worktree.`);
  const root = repoRoot(job);
  const before = inspectWorktree(root, job.worktreePath, job.baseBranch);
  if (!before.isWorktree) throw new ValidationError(`${job.worktreePath} is not a valid worktree.`);
  if (before.dirty.length > 0) {
    throw new ValidationError('Worktree has uncommitted changes; commit them before integrating.');
  }
  const fetched = remoteExists(root);
  if (fetched) git(job.worktreePath, 'fetch', 'origin', job.baseBranch);
  const ref = baseRef(root, job.baseBranch);
  if (!ref) throw new ValidationError(`Base branch ${job.baseBranch} not found.`);
  const merge = mergeInto(job.worktreePath, ref);
  const updated = recordEvent(store, id, auth, 'worktree.integrated', {
    from: ref,
    merged: merge.merged,
    head: merge.head,
  });
  return {
    job: updated,
    worktree: inspectWorktree(root, job.worktreePath, job.baseBranch),
    merge,
    fetched,
  };
}
