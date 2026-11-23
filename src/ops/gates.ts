/**
 * Git-aware gates in front of storage mutations. Evidence about code (build.md, simplify.md,
 * review verdicts, decision.md) is accepted only from a clean worktree and is recorded with the
 * HEAD it describes; a stage completes only while HEAD is still that commit. Storage alone cannot know Git, so the
 * CLI routes these three mutations through here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NotFoundError, ValidationError } from '../core/errors.ts';
import { jobArtifactDir } from '../core/paths.ts';
import { baseRef } from '../git/repo.ts';
import { tryGit } from '../git/run.ts';
import { containsRef, editedMerges, parseNameStatus } from '../git/worktree.ts';
import { sensitiveSummary } from '../core/sensitive.ts';
import {
  CHECKLIST_DELIMITER,
  deferredItems,
  openChecklist,
  ticketKey,
  unaccountedItems,
  uncheckedItems,
} from '../core/tickets.ts';
import { type Authority, authorityOf } from '../core/verification.ts';
import {
  type Action,
  approvalEvidence,
  approvalName,
  requiredArtifact,
  simplifyArtifact,
} from '../core/workflow.ts';
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
import type { Artifact, Job, Review, Ticket } from '../storage/schema.ts';
import { getTicket, listTicketEvents } from '../storage/tickets.ts';

import { effectivePolicy, sensitiveReport, verificationStatus } from './verify.ts';
import { requireClean, type Tree, worktreeOf } from './tree.ts';

/** Artifacts that describe the code and therefore need a committed, clean worktree. */
const CODE_EVIDENCE = /^(build\.md|decision\.md|round-\d+\/simplify\.md)$/;
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
        `modified: ${eff.diff.modified.join(', ') || 'none'}` +
        (eff.diff.authority ? `; authority: ${eff.diff.authority}` : '') +
        (eff.candidateError ? `; ${eff.candidateError}` : '') +
        '). ' +
        'A human must accept it (dashboard: accept-policy) or the change must be reverted.',
    );
  }
}

/** Sensitive kinds no fast job may change: they decide what the checks run and see. */
const FAST_REFUSED_KINDS: readonly string[] = ['policy', 'ci', 'test-config', 'deps'];

/**
 * A fast build delivers without review, so its diff may not touch what the evidence rests on: the
 * policy (or a file it runs), CI, test configuration, dependency manifests, or tests it disables
 * or removes, and the policy may not drift. Such a change needs the full workflow: escalate.
 * Renames are split into delete + add, so a file renamed out of its classification is still seen
 * at its old path. Checked when the build completes and again at every delivery.
 */
function requireFastScope(job: Job, info: Tree, what: string): void {
  const changes = info.baseRef
    ? parseNameStatus(
        tryGit(info.path, 'diff', '--name-status', '--no-renames', `${info.baseRef}...HEAD`) ?? '',
      )
    : info.changes;
  const report = sensitiveReport({ ...info, changes }, effectivePolicy(job, info));
  const found = [
    ...report.changes
      .filter(
        (c) =>
          FAST_REFUSED_KINDS.includes(c.kind) || (c.kind === 'tests' && c.status === 'deleted'),
      )
      .map((c) => `${c.path} (${c.kind}, ${c.status})`),
    ...report.scan.disabled.map((d) => `${d.path}: disabled test: ${d.line}`),
    ...report.scan.removedTests.map((r) => `${r.path}: ${String(r.removed)} test(s) removed`),
    ...(report.policy?.changed ? ['the verification policy changed'] : []),
  ];
  if (found.length === 0) return;
  throw new ValidationError(
    `${what} (fast job) is refused: the change is riskier than fast mode allows (${found.join('; ')}). ` +
      `Escalate (orch job transition ${job.id} escalate --reason "..."); cancel and orch ticket reopen ` +
      'the ticket to run the full workflow.',
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
    case 'simplify':
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
 * HEAD is the approved commit or builds on it: the approval (`approvalEvidence`: decision.md
 * APPROVE, or build.md for a fast job) is recorded against a commit, HEAD contains that commit,
 * and every commit since then that is not already on the base is a merge whose result matches one
 * of its parents (a clean base integration, no edits inside the merge). A rewind or a divergence
 * has nothing in approved..HEAD, so containment is checked first.
 */
function requireApproved(store: Store, job: Job, tree: Tree, what: string): void {
  const { path, head } = tree;
  const back =
    job.mode === 'fast'
      ? 'Rework the build and complete build again, or escalate.'
      : 'Return the job to review.';
  const decision = approvalEvidence(job.mode, listArtifacts(store.db, job.id));
  if (!decision?.head) {
    throw new ValidationError(
      `No ${approvalName(job.mode)} recorded against a commit; ${what} is refused.`,
    );
  }
  if (decision.head === head) return;
  if (!containsRef(path, decision.head, head)) {
    throw new ValidationError(
      `HEAD ${head.slice(0, 7)} does not contain the approved commit ${decision.head.slice(0, 7)}; ` +
        `${what} is refused. ${back}`,
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
        `only base integration merges may follow an approval, so ${what} is refused. ${back}`,
    );
  }
  const edited = editedMerges(path, decision.head, head, base);
  if (edited.length > 0) {
    const list = edited.map((m) => `${m.sha.slice(0, 7)}: ${m.files.join(', ')}`).join('; ');
    throw new ValidationError(
      `Merge commit(s) since the approval contain edits that match neither parent (${list}); ` +
        'conflict resolutions are new code. ' +
        (job.mode === 'fast' ? back : 'Rework, re-review, and re-approve first.'),
    );
  }
}

/** Whether `requireApproved` holds for HEAD. */
function approvalHolds(store: Store, job: Job, tree: Tree): boolean {
  try {
    requireApproved(store, job, tree, 'delivery');
    return true;
  } catch (err) {
    if (err instanceof ValidationError) return false;
    throw err;
  }
}

/**
 * Delivery (push, PR creation, completing pr or ci) needs a clean HEAD that is the approved
 * commit (plus clean base merges), verified under an authorized policy; `what` names the
 * operation in the refusal. Every delivery path calls this, so the approval binds what is
 * pushed and what counts as delivered alike. `preReview` (only from `deliveryGate`) drops the
 * approval check for the pre-review pass under `ci`; everything else still holds.
 */
export function requireDeliverable(
  store: Store,
  job: Job,
  tree: Tree,
  what = `completing ${job.stage}`,
  preReview = false,
): void {
  requireClean(tree, `${what} must describe a committed state.`);
  if (!preReview) requireApproved(store, job, tree, what);
  // A fast job has no reviewer behind the build gate; a resume past it must not skip its check.
  if (job.mode === 'fast') requireFastScope(job, tree, what);
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

export interface DeliveryPass {
  authority: Authority;
  /** The approval holds for HEAD; false only for the pre-review pass under `ci`. */
  approved: boolean;
}

/**
 * The gate of push, `pr create`, pr complete and ci complete. Under `ci`, while no approval holds
 * for HEAD, this is the pre-review pass: `requireDeliverable` without the approval check (clean,
 * verified at HEAD, authorized policy, and in ci a verdict for HEAD). Otherwise it is
 * `requireDeliverable` itself (decision 2026-11-22-ci-authoritative-verification).
 */
export function deliveryGate(
  store: Store,
  job: Job,
  tree: Tree,
  what = `completing ${job.stage}`,
): DeliveryPass {
  const preReview = isPreReview(store, job, tree);
  requireDeliverable(store, job, tree, what, preReview);
  return {
    authority: preReview ? 'ci' : authorityOf(effectivePolicy(job, tree).policy),
    approved: !preReview,
  };
}

/**
 * Whether this job is in the pre-review pass (`ci` authority, no approval for HEAD). A fast job
 * has no review, so it never is: its delivery always needs build.md's HEAD to hold.
 */
export function isPreReview(store: Store, job: Job, tree: Tree): boolean {
  return (
    job.mode === 'full' &&
    authorityOf(effectivePolicy(job, tree).policy) === 'ci' &&
    !approvalHolds(store, job, tree)
  );
}

/** Under `ci`, review and approval judge only a commit GitHub CI passed. */
function requireCiPassed(job: Job, tree: Tree, what: string): void {
  if (job.ciStatus === 'passing' && job.ciHead === tree.head) return;
  throw new ValidationError(
    `${what} is refused: the repository makes GitHub CI the test gate (verification.authority "ci"), ` +
      `and CI is ${job.ciStatus ?? 'not observed'} for ${job.ciHead?.slice(0, 7) ?? 'no commit'}, ` +
      `not passing for HEAD ${tree.head.slice(0, 7)}. Run a pr/ci pass for HEAD first ` +
      `(a human: orch factory resume ${job.id} --to pr).`,
  );
}

/** `requireDeliverable`'s refusal as text, or null when delivery is allowed. */
export function deliverableRefusal(store: Store, job: Job, tree: Tree): string | null {
  try {
    requireDeliverable(store, job, tree);
    return null;
  } catch (err) {
    if (err instanceof ValidationError) return err.message;
    throw err;
  }
}

/**
 * Complete the ci stage. Only `orch gh ci` calls this, in the same run that read GitHub for the
 * PR head, so a stored verdict is never reused after the PR moved, was closed, or its checks were
 * rerun (decision 53). `mergedByHuman` is passed only when that run saw the job's own PR merged at
 * the worktree HEAD before CI passed.
 */
export function completeCi(store: Store, id: string, auth: TransitionOptions): Job {
  const job = authorize(store, id, auth);
  const pass = deliveryGate(store, job, requireWorktree(job, 'completing ci'));
  return transitionJob(store, id, 'complete', { ...auth, ...pass });
}

/**
 * Approval accounts for the linked ticket's checklist: every unchecked box is ticked in the ticket
 * (`orch ticket edit`) or decision.md records it as not delivered, with the reason, under
 * `## Ticket checklist` (decision 2026-11-21-approval-accounts-for-the-ticket-checklist).
 */
function requireChecklistAccounted(store: Store, job: Job): void {
  if (job.ticketId === null) return;
  const ticket = getTicket(store.db, job.ticketId);
  const decision = findArtifact(store.db, job.id, 'decision.md');
  // Without an APPROVE decision transitionJob refuses the completion on its own.
  if (decision?.marker !== 'approve') return;
  const text = readFileSync(join(jobArtifactDir(job.id, store.paths), 'decision.md'), 'utf8');
  const key = ticketKey(job.ticketId);
  const missing = openChecklist(ticket).length === 0 ? [] : unaccountedItems(ticket.body, text);
  if (missing.length === 0) {
    requireDeferralsApplied(store, ticket, text);
    return;
  }
  throw new ValidationError(
    `Ticket ${key} has unchecked checklist item(s) that decision.md does not account for: ` +
      `${missing.map((m) => `"${m}"`).join(', ')}. For each one, either tick it with ` +
      `orch ticket edit ${key} --body-file - (delivered), or add under ## Ticket checklist in ` +
      `decision.md the line to copy: ${missing.map((m) => `- [ ] ${m}${CHECKLIST_DELIMITER}<reason>`).join(' | ')} ` +
      '(not delivered), register it with --replace, and complete again.',
  );
}

/**
 * A box decision.md defers to a follow-up (`- [ ] <item> — deferred to <id>`) has left the ticket:
 * it is no longer an unchecked box in the body, the follow-up is another active ticket, and a note
 * names it (decision 2026-11-22-deferred-box-leaves-the-ticket).
 */
function requireDeferralsApplied(store: Store, ticket: Ticket, decision: string): void {
  const key = ticketKey(ticket.id);
  const unchecked = new Set(uncheckedItems(ticket.body));
  let notes: string[] | undefined;
  for (const { item, to } of deferredItems(decision)) {
    const next = ticketKey(to);
    if (to === ticket.id) {
      throw new ValidationError(
        `"${item}" is deferred to ${next}, which is this ticket; fix the line in decision.md.`,
      );
    }
    let follow: Ticket | undefined;
    try {
      follow = getTicket(store.db, to);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    if (!follow || (follow.status !== 'open' && follow.status !== 'in-progress')) {
      throw new ValidationError(
        `"${item}" is deferred to ${next}, which ${follow ? `is ${follow.status}` : 'does not exist'}; ` +
          `file the follow-up with orch ticket add, or fix the line in decision.md's ## Ticket ` +
          `checklist, register it with --replace, and complete again.`,
      );
    }
    if (unchecked.has(item)) {
      throw new ValidationError(
        `"${item}" is deferred to ${next} but is still an unchecked box in ticket ${key}; remove ` +
          `it or rewrite it as plain text with orch ticket edit ${key} --body-file -, then ` +
          `orch ticket note ${key} "${item}: deferred to ${next}", and complete again.`,
      );
    }
    notes ??= listTicketEvents(store.db, ticket.id)
      .filter((e) => e.type === 'ticket.note')
      .map((e) => (typeof e.payload['text'] === 'string' ? e.payload['text'] : ''));
    if (!notes.some((n) => n.includes(next))) {
      throw new ValidationError(
        `"${item}" is deferred to ${next} but no note on ticket ${key} names ${next}; run ` +
          `orch ticket note ${key} "${item}: deferred to ${next}" and complete again.`,
      );
    }
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
        // Reviewers judge the commit this round's simplify pass left (or, when the round skipped
        // simplify, the one the builder built); a later commit was never built against the spec.
        const source =
          findArtifact(store.db, id, simplifyArtifact(job.round)) ??
          findArtifact(store.db, id, 'build.md');
        const what = source?.path ?? 'build.md';
        const built = source?.head ?? null;
        if (built !== evidence.head) {
          throw new ValidationError(
            `round ${String(job.round)} verdicts describe ${evidence.head.slice(0, 7)} but ${what} ` +
              `describes ${built?.slice(0, 7) ?? 'no commit'}; the code changed after the build. ` +
              'Return the job to build and review again.',
          );
        }
      }
      if (job.stage === 'build' || job.stage === 'simplify' || job.stage === 'approve') {
        requireVerified(store, job, info, `completing ${job.stage}`);
      }
      if (job.stage === 'build' && job.mode === 'fast') {
        requireFastScope(job, info, 'completing build');
      }
      if (job.stage === 'approve') requireAuthorizedPolicy(job, info, 'completing approve');
    }
    if (job.stage === 'approve') requireChecklistAccounted(store, job);
    if (job.stage === 'pr') {
      const pass = deliveryGate(store, job, requireWorktree(job, 'completing pr'));
      return transitionJob(store, id, action, { ...opts, authority: pass.authority });
    }
    if (job.stage === 'simplify' || job.stage === 'review' || job.stage === 'approve') {
      // The authority decides where simplify leads, and whether review and approve need CI first.
      // Without a worktree or a base the stage's own evidence checks refuse; local is assumed.
      let info: Tree | null = null;
      let authority: Authority | undefined;
      try {
        info = worktreeOf(job);
        authority = info ? authorityOf(effectivePolicy(job, info).policy) : undefined;
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
      }
      if (info && authority === 'ci' && job.stage !== 'simplify') {
        requireCiPassed(job, info, `completing ${job.stage}`);
      }
      return transitionJob(store, id, action, { ...opts, authority });
    }
  }
  return transitionJob(store, id, action, opts);
}
