/**
 * Job worktree operations: Git actions plus the matching database record, with ownership
 * checked before anything touches disk. Nothing here deletes uncommitted work.
 */
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { MergeConflictError, ValidationError } from '../core/errors.ts';
import { canonicalPath, jobWorktreeDir } from '../core/paths.ts';
import { baseRef, remoteExists } from '../git/repo.ts';
import { git, tryGit } from '../git/run.ts';
import {
  addWorktree,
  inspectWorktree,
  mergeEdits,
  mergeInto,
  pruneWorktrees,
  removeWorktree,
  type MergeResult,
  type WorktreeInfo,
} from '../git/worktree.ts';
import { findArtifact } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import {
  type Auth,
  authorize,
  clearWorktree,
  getJob,
  listJobs,
  setWorktree,
  transitionJob,
} from '../storage/jobs.ts';
import type { Integration, Job } from '../storage/schema.ts';
import { finishIntegration, listIntegrations, startIntegration } from '../storage/verification.ts';
import { jobCheckout } from './repo.ts';
import { requireClean, worktreeOf } from './tree.ts';
import { latestValidRun } from './verify.ts';

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

/**
 * Re-point a job at its checkout's current remote identity. Every mutation does this on its own
 * through `jobCheckout` when the job's worktree proves the checkout is still its repository; this
 * command is the operator's explicit confirmation when there is no worktree to prove it. It never
 * adopts another repository, and never overrides a worktree that contradicts the checkout.
 */
export function repointRepo(store: Store, id: string, auth: Auth, path?: string): Job {
  return jobCheckout(store, authorize(store, id, auth), auth, path, true).job;
}

/** Read-only view of the job's worktree (or of where it would be created). */
export function showWorktree(store: Store, id: string): WorktreeResult {
  const job = getJob(store.db, id);
  const path = job.worktreePath ?? jobWorktreeDir(job.id, job.repo, store.paths);
  const root = existsSync(job.repoPath) ? job.repoPath : undefined;
  const worktree = root
    ? inspectWorktree(root, path, job.baseBranch)
    : {
        ...inspectWorktree(path, path, job.baseBranch),
        isWorktree: false,
        problem: `repository checkout ${job.repoPath} does not exist`,
      };
  return { job, worktree };
}

/** Create the job's isolated worktree and branch, or return the existing one. */
export function createWorktree(
  store: Store,
  id: string,
  auth: Auth,
  opts: { repo?: string | undefined } = {},
): WorktreeResult {
  const checked = jobCheckout(store, authorize(store, id, auth), auth, opts.repo);
  let { job } = checked;
  const { root } = checked;
  auth = checked.auth;
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
  const checked = jobCheckout(store, authorize(store, id, auth), auth, opts.repo);
  const { job, root } = checked;
  auth = checked.auth;
  const path = resolve(dir);
  const info = inspectWorktree(root, path, job.baseBranch);
  if (!info.exists) throw new ValidationError(`${path} does not exist.`);
  if (!info.isWorktree) {
    throw new ValidationError(
      `${path} is not a worktree of ${job.repo}. Pass a worktree of that repository, or resume ` +
        "without --adopt so orch creates the job's worktree.",
    );
  }
  // Compare canonically: an alias spelling (8.3 short name, case, junction) must not slip past.
  const primary = canonicalPath(root);
  const target = canonicalPath(path);
  if (target === primary || target.startsWith(primary + sep)) {
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
  // The storage index compares spellings; an alias of another job's worktree must not slip past.
  const holder = listJobs(store.db).find(
    (j) => j.id !== id && j.worktreePath !== null && canonicalPath(j.worktreePath) === target,
  );
  if (holder) {
    throw new ValidationError(
      `Worktree ${path} is already assigned to job ${holder.id}. Resume that job there, or run job ` +
        `${id} from another worktree.`,
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
  const checked = jobCheckout(store, authorize(store, id, auth), auth);
  const { job, root } = checked;
  auth = checked.auth;
  if (!job.worktreePath) throw new ValidationError(`Job ${id} has no worktree.`);
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
  requireClean(info, 'commit or stash them first; orch never deletes uncommitted work.');
  removeWorktree(root, job.worktreePath);
  return { job: clearWorktree(store, id, auth, 'removed'), worktree: { ...info, exists: false } };
}

export interface IntegrateResult extends WorktreeResult {
  merge: MergeResult;
  fetched: boolean;
  integration: Integration;
  /** What must happen next: nothing, verification, or (pr stage) the builder. */
  next: 'verify' | 'rework' | 'none';
}

function mergeOutcome(wt: string, fromHead: string, resultHead: string) {
  const changed = tryGit(wt, 'diff', '--name-only', fromHead, resultHead) ?? '';
  return {
    resultHead,
    conflicts: [] as string[],
    changedFiles: changed ? changed.split(/\r?\n/) : [],
    material: mergeEdits(wt, resultHead),
  };
}

/**
 * An integration row left `started` means a previous attempt died. Work out from Git what
 * actually happened: a half-done merge is aborted (nothing committed is lost), a merge that
 * completed but was never recorded is recorded now, anything else is marked interrupted.
 */
function reconcile(store: Store, id: string, auth: Auth, wt: string, open: Integration): void {
  const inMerge = tryGit(wt, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD') !== undefined;
  if (inMerge) {
    tryGit(wt, 'merge', '--abort');
    finishIntegration(store, id, auth, open.id, {
      status: 'interrupted',
      resultHead: null,
      conflicts: [],
      changedFiles: [],
      material: [],
    });
    return;
  }
  const head = git(wt, 'rev-parse', 'HEAD');
  const parents = tryGit(wt, 'rev-list', '--parents', '-n', '1', head)?.split(/\s+/) ?? [];
  if (head !== open.fromHead && parents.includes(open.fromHead) && parents.includes(open.baseSha)) {
    finishIntegration(store, id, auth, open.id, {
      status: 'merged',
      ...mergeOutcome(wt, open.fromHead, head),
    });
    return;
  }
  finishIntegration(store, id, auth, open.id, {
    status: 'interrupted',
    resultHead: head === open.fromHead ? null : head,
    conflicts: [],
    changedFiles: [],
    material: [],
  });
}

/**
 * Bring base-branch changes into the job branch with a merge commit, recording the inputs before
 * Git runs and the outcome after. Fetches origin first when there is one. Refused on a dirty
 * worktree. Conflicts abort the merge; in the pr stage the job then goes back to build (the
 * builder resolves, and the result is verified, reviewed, and approved again), elsewhere the
 * conflict is raised as an error. A completed merge still needs fresh verification.
 */
export function integrateBase(store: Store, id: string, auth: Auth): IntegrateResult {
  const checked = jobCheckout(store, authorize(store, id, auth), auth);
  const { job, root } = checked;
  auth = checked.auth;
  if (!job.worktreePath) throw new ValidationError(`Job ${id} has no worktree.`);
  const wt = job.worktreePath;
  const open = listIntegrations(store.db, id).find((i) => i.status === 'started');
  if (open) reconcile(store, id, auth, wt, open);
  const before = inspectWorktree(root, wt, job.baseBranch);
  if (!before.isWorktree) throw new ValidationError(`${wt} is not a valid worktree.`);
  requireClean(before, 'commit them before integrating.');
  const fetched = remoteExists(root);
  if (fetched) git(wt, 'fetch', 'origin', job.baseBranch);
  const ref = baseRef(root, job.baseBranch);
  if (!ref) throw new ValidationError(`Base branch ${job.baseBranch} not found.`);
  const fromHead = git(wt, 'rev-parse', 'HEAD');
  const baseSha = git(wt, 'rev-parse', `${ref}^{commit}`);
  const mergeBase = tryGit(wt, 'merge-base', ref, 'HEAD') ?? null;
  const tree = worktreeOf(job);
  const decision = findArtifact(store.db, id, 'decision.md');
  const valid = tree ? latestValidRun(store, job, tree) : undefined;
  let integration = startIntegration(store, id, {
    ...auth,
    fromHead,
    baseRef: ref,
    baseSha,
    mergeBase,
    decisionHead: decision?.marker === 'approve' ? decision.head : null,
    verificationRunId: valid?.run.id ?? null,
  });
  if (mergeBase === baseSha) {
    integration = finishIntegration(store, id, auth, integration.id, {
      status: 'up-to-date',
      resultHead: fromHead,
      conflicts: [],
      changedFiles: [],
      material: [],
    });
    return {
      job: getJob(store.db, id),
      worktree: inspectWorktree(root, wt, job.baseBranch),
      merge: { merged: false, upToDate: true, head: fromHead },
      fetched,
      integration,
      next: valid ? 'none' : 'verify',
    };
  }
  let merge: MergeResult;
  try {
    merge = mergeInto(wt, ref);
  } catch (err) {
    const files = err instanceof MergeConflictError ? err.files : [];
    integration = finishIntegration(store, id, auth, integration.id, {
      status: 'conflict',
      resultHead: null,
      conflicts: files,
      changedFiles: [],
      material: [],
    });
    if (job.stage !== 'pr') throw err;
    const reworked = transitionJob(store, id, 'rework', {
      token: auth.token,
      reason: `base integration of ${ref} conflicts in ${files.join(', ') || 'unknown files'}`,
    });
    return {
      job: reworked,
      worktree: inspectWorktree(root, wt, job.baseBranch),
      merge: { merged: false, upToDate: false, head: fromHead },
      fetched,
      integration,
      next: 'rework',
    };
  }
  const outcome = mergeOutcome(wt, fromHead, merge.head);
  integration = finishIntegration(store, id, auth, integration.id, {
    status: 'merged',
    ...outcome,
  });
  let next: IntegrateResult['next'] = 'verify';
  let updated = getJob(store.db, id);
  if (outcome.material.length > 0 && job.stage === 'pr') {
    updated = transitionJob(store, id, 'rework', {
      token: auth.token,
      reason: `merge ${merge.head.slice(0, 7)} edited ${outcome.material.join(', ')} beyond either parent`,
    });
    next = 'rework';
  }
  return {
    job: updated,
    worktree: inspectWorktree(root, wt, job.baseBranch),
    merge,
    fetched,
    integration,
    next,
  };
}
