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
import { baseRef } from '../git/repo.ts';
import { tryGit } from '../git/run.ts';
import { containsRef, editedMerges } from '../git/worktree.ts';
import { sensitiveSummary } from '../core/sensitive.ts';
import { type Action, requiredArtifact } from '../core/workflow.ts';
import { findArtifact, listArtifacts } from '../storage/artifacts.ts';
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
const CODE_EVIDENCE = /^(build\.md|decision\.md)$/;
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

/** Evidence about code needs the job's worktree; without one there is nothing it can describe. */
function requireWorktree(job: Job, what: string): Tree {
  const info = worktreeOf(job);
  if (!info) {
    throw new ValidationError(
      `${what} needs the job worktree; run orch worktree create ${job.id} first.`,
    );
  }
  return info;
}

/** Refuse unless the latest verification run is evidence for HEAD under the effective policy. */
function requireVerified(
  store: Store,
  job: Job,
  info: Tree,
  what: string,
  eff = effectivePolicy(job, info),
): void {
  const status = verificationStatus(store, job, info, eff);
  if (!status.valid) {
    throw new ValidationError(
      `No valid verification run for HEAD ${info.head.slice(0, 7)} (${what}): ${status.reason ?? 'none'}. Run orch verify ${job.id}.`,
    );
  }
}

/** Refuse while the worktree's factory.json differs from the effective policy without a human's say. */
function requireAuthorizedPolicy(
  job: Job,
  info: Tree,
  what: string,
  eff = effectivePolicy(job, info),
): void {
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
    info = requireWorktree(job, rel);
    requireClean(info, `${rel} must describe a committed state.`);
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

/**
 * HEAD is the approved commit or builds on it: decision.md is APPROVE recorded against a commit,
 * HEAD contains that commit, and every commit since then that is not already on the base is a
 * merge whose result matches one of its parents (a clean base integration, no edits inside the
 * merge). A rewind or a divergence has nothing in approved..HEAD, so containment is checked first.
 */
function requireApproved(store: Store, job: Job, tree: Tree, what: string): void {
  const { path, head } = tree;
  const decision = findArtifact(store.db, job.id, 'decision.md');
  if (decision?.marker !== 'approve' || !decision.head) {
    throw new ValidationError(
      `No DECISION: APPROVE recorded against a commit; ${what} is refused.`,
    );
  }
  if (decision.head === head) return;
  if (!containsRef(path, decision.head, head)) {
    throw new ValidationError(
      `HEAD ${head.slice(0, 7)} does not contain the approved commit ${decision.head.slice(0, 7)}; ` +
        `${what} is refused. Return the job to review.`,
    );
  }
  const base = baseRef(path, job.baseBranch);
  const unreviewed = tryGit(
    path,
    'rev-list',
    '--no-merges',
    `${decision.head}..${head}`,
    ...(base ? [`^${base}`] : []),
  );
  if (unreviewed === undefined || unreviewed !== '') {
    throw new ValidationError(
      `HEAD ${head.slice(0, 7)} has commits that were not approved (approved: ${decision.head.slice(0, 7)}); ` +
        `only base integration merges may follow an approval, so ${what} is refused. Return the job to review.`,
    );
  }
  const edited = editedMerges(path, decision.head, head);
  if (edited.length > 0) {
    const list = edited.map((m) => `${m.sha.slice(0, 7)}: ${m.files.join(', ')}`).join('; ');
    throw new ValidationError(
      `Merge commit(s) since the approval contain edits that match neither parent (${list}); ` +
        'conflict resolutions are new code. Rework, re-review, and re-approve first.',
    );
  }
}

/**
 * Delivery (push, PR creation, completing pr or ci) needs a clean HEAD that is the approved
 * commit (plus clean base merges), verified under an authorized policy; `what` names the
 * operation in the refusal. Every delivery path calls this, so the approval binds what is
 * pushed and what counts as delivered alike.
 */
export function requireDeliverable(
  store: Store,
  job: Job,
  tree: Tree,
  what = `completing ${job.stage}`,
): void {
  requireClean(tree, `${what} must describe a committed state.`);
  requireApproved(store, job, tree, what);
  // GitHub's verdict counts only for the commit it was read for.
  if (job.stage === 'ci' && job.ciHead !== tree.head) {
    throw new ValidationError(
      `CI was last observed for ${job.ciHead?.slice(0, 7) ?? 'no commit'} but HEAD is ` +
        `${tree.head.slice(0, 7)}; run orch gh ci ${job.id} again.`,
    );
  }
  const eff = effectivePolicy(job, tree);
  requireVerified(store, job, tree, what, eff);
  requireAuthorizedPolicy(job, tree, what, eff);
}

/**
 * Complete the ci stage. Only `orch gh ci` calls this, in the same run that read GitHub for the
 * PR head, so a stored verdict is never reused after the PR moved, was closed, or its checks were
 * rerun (decision 53).
 */
export function completeCi(store: Store, id: string, auth: TransitionOptions): Job {
  const job = authorize(store, id, auth);
  requireDeliverable(store, job, requireWorktree(job, 'completing ci'));
  return transitionJob(store, id, 'complete', auth);
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
    if (job.stage === 'ci') {
      throw new ValidationError(
        `The ci stage is completed by orch gh ci ${id}, which re-reads GitHub for the PR head; ` +
          'a stored verdict cannot complete it.',
      );
    }
    const evidence = evidenceHead(job, listArtifacts(store.db, id), listReviews(store.db, id));
    if (evidence) {
      const info = requireWorktree(job, `completing ${job.stage}`);
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
      if (job.stage === 'review') {
        // Reviewers judge the commit the builder built; a commit made since then was never built
        // against the spec, even when every verdict was recorded against it.
        const built = findArtifact(store.db, id, 'build.md')?.head ?? null;
        if (built !== evidence.head) {
          throw new ValidationError(
            `round ${String(job.round)} verdicts describe ${evidence.head.slice(0, 7)} but build.md ` +
              `describes ${built?.slice(0, 7) ?? 'no commit'}; the code changed after the build. ` +
              'Return the job to build and review again.',
          );
        }
      }
      if (job.stage === 'build' || job.stage === 'approve') {
        requireVerified(store, job, info, `completing ${job.stage}`);
      }
      if (job.stage === 'approve') requireAuthorizedPolicy(job, info, 'completing approve');
    }
    if (job.stage === 'pr') {
      requireDeliverable(store, job, requireWorktree(job, 'completing pr'));
    }
  }
  return transitionJob(store, id, action, opts);
}
