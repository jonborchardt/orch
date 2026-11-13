/**
 * Git-aware gates in front of storage mutations. Evidence about code (build.md, review verdicts,
 * decision.md) is accepted only from a clean worktree and is recorded with the HEAD it describes;
 * a stage completes only while HEAD is still that commit. Storage alone cannot know Git, so the
 * CLI routes these three mutations through here.
 */
import { existsSync } from 'node:fs';

import { ValidationError } from '../core/errors.ts';
import { type Action, requiredArtifact } from '../core/workflow.ts';
import { inspectWorktree, type WorktreeInfo } from '../git/worktree.ts';
import { listArtifacts } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import {
  authorize,
  listReviews,
  recordReview,
  type RegisterOptions,
  registerArtifact,
  type ReviewInput,
  transitionJob,
  type TransitionOptions,
} from '../storage/jobs.ts';
import type { Artifact, Job, Review } from '../storage/schema.ts';

/** Artifacts that describe the code and therefore need a committed, clean worktree. */
const CODE_EVIDENCE = /^(build\.md|decision\.md|round-\d+\/review-[a-z0-9-]+\.md)$/;

/** The job's worktree, or null when it has none. Throws when it is recorded but unusable. */
export function worktreeOf(job: Job): (WorktreeInfo & { head: string }) | null {
  if (!job.worktreePath) return null;
  const root = existsSync(job.repoPath) ? job.repoPath : job.worktreePath;
  const info = inspectWorktree(root, job.worktreePath, job.baseBranch);
  if (!info.exists) {
    throw new ValidationError(`Worktree ${job.worktreePath} is missing; run orch worktree create.`);
  }
  if (!info.isWorktree || !info.head) {
    throw new ValidationError(`${job.worktreePath} is not a usable worktree of ${job.repo}.`);
  }
  return { ...info, head: info.head };
}

function requireClean(info: WorktreeInfo, what: string): void {
  if (info.dirty.length === 0) return;
  const list = info.dirty.slice(0, 5).join(', ') + (info.dirty.length > 5 ? ', ...' : '');
  throw new ValidationError(
    `Worktree has uncommitted changes (${list}); ${what} must describe a committed state.`,
  );
}

/** `orch job artifact add`: register with the worktree HEAD; code evidence needs a clean tree. */
export function addArtifact(
  store: Store,
  id: string,
  relPath: string,
  opts: RegisterOptions,
): Artifact {
  const job = authorize(store, id, opts);
  const rel = relPath.split('\\').join('/');
  let info: (WorktreeInfo & { head: string }) | null;
  if (CODE_EVIDENCE.test(rel)) {
    info = worktreeOf(job);
    if (info) requireClean(info, rel);
  } else {
    // Other artifacts just note the HEAD when there is one; a missing worktree is not their problem.
    try {
      info = worktreeOf(job);
    } catch {
      info = null;
    }
  }
  return registerArtifact(store, id, relPath, { ...opts, head: info?.head ?? null });
}

/** `orch job review record`: a verdict is recorded against a clean worktree's HEAD. */
export function recordVerdict(store: Store, id: string, input: ReviewInput): Review {
  const job = authorize(store, id, input);
  const info = input.verdict ? worktreeOf(job) : null;
  if (info) requireClean(info, 'a review verdict');
  return recordReview(store, id, { ...input, head: info?.head ?? null });
}

/** HEAD the current stage's evidence was recorded against; undefined when the stage has none. */
function evidenceHead(
  job: Job,
  artifacts: Artifact[],
  reviews: Review[],
): { what: string; head: string | null } | undefined {
  const required = requiredArtifact(job.stage, job.round);
  switch (job.stage) {
    case 'build':
    case 'approve': {
      const a = artifacts.find((x) => x.path === required);
      return a ? { what: a.path, head: a.head } : undefined;
    }
    case 'review': {
      const r = reviews.find((x) => x.round === job.round && x.verdict !== null);
      return r ? { what: `round ${String(job.round)} verdicts`, head: r.head } : undefined;
    }
    default:
      return undefined;
  }
}

/** `orch job transition`: `complete` is refused when the worktree moved past its evidence. */
export function transitionGuarded(
  store: Store,
  id: string,
  action: Action,
  opts: TransitionOptions,
): Job {
  if (action === 'complete') {
    const job = authorize(store, id, opts);
    const evidence = evidenceHead(job, listArtifacts(store.db, id), listReviews(store.db, id));
    const info = evidence && job.worktreePath ? worktreeOf(job) : null;
    if (info && evidence) {
      requireClean(info, `completing ${job.stage}`);
      if (!evidence.head) {
        throw new ValidationError(
          `${evidence.what} were recorded without a worktree commit; record them again.`,
        );
      }
      if (evidence.head !== info.head) {
        throw new ValidationError(
          `HEAD is ${info.head.slice(0, 7)} but ${evidence.what} describe ${evidence.head.slice(0, 7)}; ` +
            'the implementation changed since that evidence was collected. Record it again.',
        );
      }
    }
  }
  return transitionJob(store, id, action, opts);
}
