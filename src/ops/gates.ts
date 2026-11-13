/**
 * Git-aware gates in front of storage mutations. Evidence about code (build.md, review verdicts,
 * decision.md) is accepted only from a clean worktree and is recorded with the HEAD it describes;
 * a stage completes only while HEAD is still that commit. Storage alone cannot know Git, so the
 * CLI routes these three mutations through here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { jobArtifactDir } from '../core/paths.ts';
import { sensitiveSummary } from '../core/sensitive.ts';
import { type Action, requiredArtifact } from '../core/workflow.ts';
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

import { effectivePolicy, sensitiveReport, verificationStatus } from './verify.ts';
import { requireClean, type Tree, worktreeOf } from './tree.ts';

/** Artifacts that describe the code and therefore need a committed, clean worktree. */
const CODE_EVIDENCE = /^(build\.md|decision\.md|round-\d+\/review-[a-z0-9-]+\.md)$/;
/** Artifacts that must name every sensitive change in the diff. */
const SUMMARIES = /^(round-\d+\/consolidated\.md|pr\.md)$/;

/** Consolidations and PR bodies must carry a "Sensitive changes" section naming each path. */
function requireSensitiveSection(store: Store, job: Job, info: Tree, rel: string): void {
  const report = sensitiveReport(info, effectivePolicy(job, info));
  const lines = sensitiveSummary(report);
  if (lines.length === 0) return;
  const text = readFileSync(join(jobArtifactDir(job.id, store.paths), ...rel.split('/')), 'utf8');
  if (!/^#{1,6}\s*Sensitive changes\b/im.test(text)) {
    throw new ValidationError(
      `${rel} needs a "Sensitive changes" section covering: ${lines.join('; ')}`,
    );
  }
  const missing = report.changes.map((c) => c.path).filter((p) => !text.includes(p));
  if (missing.length > 0) {
    throw new ValidationError(
      `${rel}: the Sensitive changes section does not mention ${missing.join(', ')}`,
    );
  }
}

/** Refuse unless the latest verification run is evidence for HEAD under the effective policy. */
function requireVerified(store: Store, job: Job, info: Tree, what: string): void {
  const status = verificationStatus(store, job, info);
  if (!status.valid) {
    throw new ValidationError(
      `${what} needs a valid verification run for HEAD ${info.head.slice(0, 7)}: ${status.reason ?? 'none'}. Run orch verify ${job.id}.`,
    );
  }
}

/** Refuse while the worktree's factory.json differs from the effective policy without a human's say. */
function requireAuthorizedPolicy(job: Job, info: Tree, what: string): void {
  const eff = effectivePolicy(job, info);
  if (eff.diff) {
    throw new ValidationError(
      `${what} is refused: the worktree's factory.json changes the verification policy ` +
        `(added: ${eff.diff.added.join(', ') || 'none'}; removed: ${eff.diff.removed.join(', ') || 'none'}; ` +
        `modified: ${eff.diff.modified.join(', ') || 'none'}${eff.candidateError ? `; ${eff.candidateError}` : ''}). ` +
        'A human must accept it (dashboard: accept-policy) or the change must be reverted.',
    );
  }
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
  let info: Tree | null;
  if (CODE_EVIDENCE.test(rel)) {
    info = worktreeOf(job);
    if (info) requireClean(info, `${rel} must describe a committed state.`);
  } else if (SUMMARIES.test(rel)) {
    info = worktreeOf(job);
    if (info?.baseRef) requireSensitiveSection(store, job, info, rel);
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
  if (info) requireClean(info, 'a review verdict must describe a committed state.');
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
      requireClean(info, `completing ${job.stage} must describe a committed state.`);
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
      if (job.stage === 'build' || job.stage === 'approve') {
        requireVerified(store, job, info, `completing ${job.stage}`);
      }
      if (job.stage === 'approve') requireAuthorizedPolicy(job, info, 'completing approve');
    }
    if (job.stage === 'pr' && job.worktreePath) {
      const tree = worktreeOf(job);
      if (tree) {
        requireClean(tree, 'completing pr must describe a committed state.');
        requireVerified(store, job, tree, 'completing pr');
        requireAuthorizedPolicy(job, tree, 'completing pr');
      }
    }
  }
  return transitionJob(store, id, action, opts);
}
