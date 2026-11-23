/**
 * The workflow contract: stages, statuses, and the pure transition function.
 *
 * Claude requests a transition; this module decides whether it is legal given the job and its
 * registered results, and returns the new job fields plus the events to append. It performs no
 * I/O. `src/storage/jobs.ts` applies the result inside a transaction.
 */
import { UsageError, WorkflowError } from './errors.ts';
import { ROLES } from './roles.ts';
import type { Authority } from './verification.ts';
import type { Artifact, Job, Review } from '../storage/schema.ts';

export const STAGES = [
  'spec',
  'build',
  'simplify',
  'review',
  'approve',
  'pr',
  'ci',
  'needs-human',
  'completed',
] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = [
  'pending',
  'running',
  'blocked',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
] as const;
export type Status = (typeof STATUSES)[number];

/**
 * How a job travels through STAGES. `full`: every stage. `fast` (opt-in, `orch do --fast`): created
 * in build, then pr, ci, completed; no spec, simplify, review, or approve (decision
 * 2026-11-23-fast-mode). The same transition, gates, and delivery rules serve both.
 */
export const JOB_MODES = ['full', 'fast'] as const;
export type JobMode = (typeof JOB_MODES)[number];

/** Where a fast job may be resumed to from needs-human; anything else is a full-workflow job. */
const FAST_RESUME_TARGETS: readonly Stage[] = ['build', 'pr', 'ci', 'completed'];

/**
 * The artifact that is a job's approval, or undefined when none is registered: decision.md saying
 * APPROVE for a full job, build.md for a fast job (it has no approver). Its `head` is the approved
 * head; delivery (`requireApproved` in ops/gates.ts) refuses one recorded without a head. Every
 * reader of the approved head asks this; none branches on the mode itself.
 */
export function approvalEvidence(
  mode: JobMode,
  artifacts: readonly Artifact[],
): Artifact | undefined {
  const a = artifacts.find((x) => x.path === approvalPath(mode));
  return mode === 'fast' || a?.marker === 'approve' ? a : undefined;
}

/** The artifact `approvalEvidence` reads. */
export function approvalPath(mode: JobMode): 'build.md' | 'decision.md' {
  return mode === 'fast' ? 'build.md' : 'decision.md';
}

/** What `approvalEvidence` looks for, for refusals. */
export function approvalName(mode: JobMode): string {
  return mode === 'fast' ? 'build.md' : 'DECISION: APPROVE';
}

export const VERDICTS = ['pass', 'changes'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** `closed` means closed without merging, as GitHub reported it; cancelling a job never implies it. */
export const PR_STATES = ['draft', 'ready', 'merged', 'closed'] as const;
export type PrState = (typeof PR_STATES)[number];

/** Rollup of a PR's checks: `none` when the PR has no checks configured. */
export const CI_STATUSES = ['pending', 'passing', 'failing', 'none'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export const ACTIONS = [
  'start',
  'complete',
  'fail',
  'escalate',
  'resume',
  'rework',
  'cancel',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * What a session escalating with `--choice` may offer the human: each kind is one existing
 * dashboard decision (decision 2026-11-23-needs-human-choices). `resume` names its stage.
 */
export const CHOICE_KINDS = ['resume', 'rework', 'review', 'accept-delivery', 'cancel'] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];
export interface Choice {
  kind: ChoiceKind;
  /** `resume` only: the stage the job returns to. */
  to?: Stage;
  label: string;
}
export const MAX_CHOICES = 5;
export const CHOICE_LABEL_MAX = 120;
/** Stages a `resume:<stage>` choice may name: every stage the dashboard's Resume can return to. */
const CHOICE_STAGES: readonly Stage[] = [
  'spec',
  'build',
  'simplify',
  'review',
  'approve',
  'pr',
  'ci',
];
// The same characters notices strip (`stripControl` in flake.ts): a label is shown as one line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Parse `--choice "<kind>[:<stage>]=<label>"` values; undefined when none were given. Refuses
 * (UsageError) an unknown kind, a stage on anything but resume or a missing or undeliverable one,
 * and a blank, over-long, control-character, or duplicate label, and more than MAX_CHOICES.
 */
export function parseChoices(values: readonly string[] | undefined): Choice[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  if (values.length > MAX_CHOICES) {
    throw new UsageError(`At most ${String(MAX_CHOICES)} --choice values are allowed.`);
  }
  const out: Choice[] = [];
  for (const value of values) {
    const bad = (why: string): never => {
      throw new UsageError(`--choice ${JSON.stringify(value)}: ${why}`);
    };
    const eq = value.indexOf('=');
    if (eq < 0) bad('expected <kind>[:<stage>]=<label>');
    const [kind, stage, ...extra] = value.slice(0, eq).split(':');
    const label = value.slice(eq + 1).trim();
    if (!CHOICE_KINDS.includes(kind as ChoiceKind)) {
      bad(`kind must be one of ${CHOICE_KINDS.join(', ')}`);
    }
    if (extra.length > 0) bad('expected <kind>[:<stage>]=<label>');
    if (kind === 'resume' && !CHOICE_STAGES.includes(stage as Stage)) {
      bad(`resume needs :<stage>, one of ${CHOICE_STAGES.join(', ')}`);
    }
    if (kind !== 'resume' && stage !== undefined) bad(`only resume takes a :<stage>`);
    if (label === '') bad('the label is blank');
    if (label.length > CHOICE_LABEL_MAX) {
      bad(`the label is longer than ${String(CHOICE_LABEL_MAX)} characters`);
    }
    if (CONTROL_CHAR.test(label)) bad('the label contains control characters');
    if (out.some((c) => c.label === label)) bad('the label is used by another choice');
    out.push(
      kind === 'resume' ? { kind, to: stage as Stage, label } : { kind: kind as ChoiceKind, label },
    );
  }
  return out;
}

export const TERMINAL_STATUSES: readonly Status[] = ['completed', 'cancelled'];
/** Statuses a session resumes from (`blocked` always comes with stage needs-human). */
export const RESUMABLE_STATUSES: readonly Status[] = ['interrupted', 'failed'];

/** Reason recorded on `job.blocked` when the `maxRounds`-th review round requests changes. */
export const MAX_ROUNDS_REASON = 'max review rounds reached';
/** Reason recorded on `job.blocked` when CI still fails after `maxCiRepairs` repair cycles. */
export const MAX_CI_REPAIRS_REASON = 'max CI repair cycles reached';
/** Reason recorded on `job.blocked` when approval finds a scope gap after the automatic rework. */
export const SCOPE_GAP_REASON = 'scope gap found again after the automatic scope rework';

/**
 * Where a decision.md marker sends the job for a scope gap: `rework-build` (the code is less than
 * the spec) to build, `rework-spec` (the spec is less than the request) to spec. Null otherwise.
 */
export function scopeGapTarget(marker: string | null | undefined): 'build' | 'spec' | null {
  if (marker === 'rework-build') return 'build';
  if (marker === 'rework-spec') return 'spec';
  return null;
}

/**
 * Why spec may not complete after a REWORK-SPEC decision, or null: the spec.md that decision
 * judged (its recorded hash) must have been replaced first.
 */
export function scopeGapSpecRefusal(artifacts: readonly Artifact[]): string | null {
  const decision = artifacts.find((a) => a.path === 'decision.md');
  const spec = artifacts.find((a) => a.path === 'spec.md');
  if (decision?.marker !== 'rework-spec' || !decision.specSha256) return null;
  if (decision.specSha256 !== spec?.sha256) return null;
  return 'decision.md says REWORK-SPEC for this spec.md; revise spec.md (--replace) to cover the request, then re-challenge it';
}

/** Artifact a stage must register (relative to the job artifact dir) before it can complete. */
export function requiredArtifact(stage: Stage, round: number): string | undefined {
  switch (stage) {
    case 'spec':
      return 'spec.md';
    case 'build':
      return 'build.md';
    case 'simplify':
      return simplifyArtifact(round);
    case 'review':
      return `round-${String(round)}/consolidated.md`;
    case 'approve':
      return 'decision.md';
    case 'pr':
      return 'pr.md';
    default:
      return undefined;
  }
}

/** The builder's record of applied and declined simplify findings for a round. */
export function simplifyArtifact(round: number): string {
  return `round-${String(round)}/simplify.md`;
}

/** The simplifier's over-engineering findings for a round. */
export function simplifyReviewArtifact(round: number): string {
  return `round-${String(round)}/simplify-review.md`;
}

export function reviewArtifact(round: number, reviewer: string): string {
  return `round-${String(round)}/review-${reviewer}.md`;
}

/** The independent spec challenge: `spec-review-1.md`, then `spec-review-2.md` after a revision. */
export const SPEC_CHALLENGER =
  ROLES.find((r) => r.kind === 'spec-challenge')?.agent ?? 'spec challenger';
const CHALLENGE = /^spec-review-([12])\.md$/;
/** Any spec-review-N.md name; only the two CHALLENGE slots may be registered. */
const CHALLENGE_NAME = /^spec-review-\d+\.md$/;

/** The challenge slot (1 or 2) of `path`, or 0 when it is not a spec challenge. */
export function challengeSlot(path: string): number {
  return Number(CHALLENGE.exec(path)?.[1] ?? 0);
}

export function isSpecChallenge(path: string): boolean {
  return challengeSlot(path) > 0;
}

/** True for every spec-review-N.md path, including the ones that are refused. */
export function looksLikeSpecChallenge(path: string): boolean {
  return CHALLENGE_NAME.test(path);
}

/** The registered spec challenge with the highest number, or undefined when there is none. */
export function latestChallenge(artifacts: readonly Artifact[]): Artifact | undefined {
  const num = (a: Artifact) => challengeSlot(a.path);
  return artifacts
    .filter((a) => isSpecChallenge(a.path))
    .reduce<Artifact | undefined>((best, a) => (!best || num(a) > num(best) ? a : best), undefined);
}

/**
 * The spec.md hash a challenge registered at `path` binds to. Refused for any spec-review-N.md
 * other than 1 and 2, before spec.md is registered, and for spec-review-2.md unless
 * spec-review-1.md asked for changes.
 */
export function challengeSpecHash(path: string, artifacts: readonly Artifact[]): string {
  if (!isSpecChallenge(path)) {
    throw new WorkflowError(
      `${path} is not a spec challenge slot; only spec-review-1.md and spec-review-2.md are accepted.`,
    );
  }
  const spec = artifacts.find((a) => a.path === 'spec.md');
  if (!spec?.sha256) {
    throw new WorkflowError(`${path} reviews spec.md; register spec.md first.`);
  }
  if (path === 'spec-review-2.md') {
    const first = artifacts.find((a) => a.path === 'spec-review-1.md');
    if (first?.marker !== 'changes') {
      throw new WorkflowError(
        'spec-review-2.md is only for a second challenge after spec-review-1.md says CHANGES; register spec-review-1.md instead (--replace to re-challenge a revised spec).',
      );
    }
  }
  return spec.sha256;
}

/**
 * Why the spec may not move on, or null when it may: the latest challenge must be a PASS given
 * against the spec.md that is registered now.
 */
export function specChallengeRefusal(
  artifacts: readonly Artifact[],
  resuming = false,
): string | null {
  const spec = artifacts.find((a) => a.path === 'spec.md');
  const latest = latestChallenge(artifacts);
  if (!latest) {
    return `no spec challenge is registered; run ${SPEC_CHALLENGER} and register spec-review-1.md`;
  }
  if (latest.marker !== 'pass') {
    const advice = resuming
      ? 'revise spec.md and re-challenge it, then resume'
      : 'revise spec.md or escalate';
    return `${latest.path} from ${SPEC_CHALLENGER} says ${(latest.marker ?? 'nothing').toUpperCase()}; ${advice}`;
  }
  if (latest.specSha256 !== spec?.sha256) {
    return `${latest.path} from ${SPEC_CHALLENGER} passed an earlier spec.md; challenge the current spec again`;
  }
  return null;
}

export interface Next {
  stage: Stage;
  status: Status;
  requiredArtifacts: string[];
  /** Present when the stage is simplify or review. */
  round?: number;
}

export function describeNext(job: Pick<Job, 'stage' | 'status' | 'round'>): Next {
  const required = requiredArtifact(job.stage, job.round);
  const next: Next = {
    stage: job.stage,
    status: job.status,
    requiredArtifacts: required ? [required] : [],
  };
  if (job.stage === 'simplify') next.requiredArtifacts.unshift(simplifyReviewArtifact(job.round));
  if (job.stage === 'simplify' || job.stage === 'review') next.round = job.round;
  return next;
}

export interface TransitionContext {
  artifacts: Artifact[];
  reviews: Review[];
  /** Target stage when resuming from needs-human. */
  to?: Stage | undefined;
  reason?: string | undefined;
  /**
   * `ci` complete only: GitHub reported the job's own PR merged at the worktree HEAD in the same
   * `orch gh ci` call. Only `completeCi` passes it; a stored `prState: merged` never implies it.
   */
  mergedByHuman?: boolean | undefined;
  /**
   * `rework` only: base integration needed the builder. Only `integrateBase` passes it; from `ci`
   * it reworks like approve and pr, spending no CI repair.
   */
  integration?: boolean | undefined;
  /**
   * The effective policy's authority (default `local`). Under `ci` the order is simplify -> pr ->
   * ci -> review -> approve -> pr -> ci -> completed: the first pr/ci pass runs before review.
   */
  authority?: Authority | undefined;
  /**
   * `ci` complete under `ci` only: the approval holds for HEAD (`requireApproved`). Without it the
   * verdict is the pre-review pass and the job goes to review instead of completing.
   */
  approved?: boolean | undefined;
  /** `escalate` only: the answers the human may pick (`parseChoices`), kept on `job.blocked`. */
  choices?: Choice[] | undefined;
}

export interface TransitionResult {
  patch: Partial<Job>;
  events: { type: string; payload: Record<string, unknown> }[];
}

type JobState = Pick<
  Job,
  | 'stage'
  | 'status'
  | 'round'
  | 'maxRounds'
  | 'returnStage'
  | 'prUrl'
  | 'prState'
  | 'ciStatus'
  | 'ciHead'
  | 'ciRepairs'
  | 'maxCiRepairs'
  | 'scopeReworks'
  | 'startedAt'
> &
  // Absent means `full`, the mode of every job created before modes existed.
  Partial<Pick<Job, 'mode'>>;

/** Pure decision: throws WorkflowError when the action is illegal in the current state. */
export function transition(
  job: JobState,
  action: Action,
  ctx: TransitionContext,
): TransitionResult {
  const { stage, status } = job;
  // Explicit annotation lets TypeScript narrow after a reject() call.
  const reject: (why: string) => never = (why) => {
    throw new WorkflowError(`Cannot ${action} job in stage=${stage} status=${status}: ${why}`);
  };
  if (TERMINAL_STATUSES.includes(status) && action !== 'cancel') reject('job is finished');

  switch (action) {
    case 'start': {
      if (stage === 'needs-human') reject('resume with --to <stage> first');
      if (!['pending', 'failed', 'interrupted'].includes(status)) reject('stage is not startable');
      return {
        // The job's first start is stamped once; restarts keep it.
        patch: job.startedAt ? { status: 'running' } : { status: 'running', startedAt: now() },
        events: [{ type: 'stage.started', payload: { stage } }],
      };
    }

    case 'complete': {
      if (status !== 'running') reject('stage is not running');
      // Reviewer completeness is reported before the consolidated artifact, since it comes first.
      if (stage === 'review') verifyReviewers(currentReviews(job, ctx.reviews));
      // The simplifier's findings come before the builder's record of what was applied.
      if (stage === 'simplify') {
        const findings = simplifyReviewArtifact(job.round);
        if (!ctx.artifacts.some((a) => a.path === findings)) {
          reject(`missing required artifact ${findings}`);
        }
      }
      const required = requiredArtifact(stage, job.round);
      const artifact = required ? ctx.artifacts.find((a) => a.path === required) : undefined;
      if (required && !artifact) reject(`missing required artifact ${required}`);
      const completed = { type: 'stage.completed', payload: { stage, round: job.round } };
      const blocking = blockingCount(ctx.artifacts, job.round);
      const mode = job.mode ?? 'full';
      // A fast job has no pre-review pass: its approval (build.md) exists before pr.
      const ciFirst = ctx.authority === 'ci' && mode === 'full';
      switch (stage) {
        case 'spec': {
          const refused = scopeGapSpecRefusal(ctx.artifacts) ?? specChallengeRefusal(ctx.artifacts);
          if (refused) reject(refused);
          return { patch: { stage: 'build', status: 'pending' }, events: [completed] };
        }
        case 'build':
          // A fast job delivers its build: build.md is its approval.
          if (mode === 'fast') {
            return { patch: { stage: 'pr', status: 'pending' }, events: [completed] };
          }
          // Every build opens the next review round; its simplify pass belongs to that round.
          return {
            patch: { stage: 'simplify', status: 'pending', round: job.round + 1 },
            events: [completed],
          };
        case 'simplify':
          // Under `ci` the verified commit goes through GitHub CI before anyone reviews it.
          return {
            patch: { stage: ciFirst ? 'pr' : 'review', status: 'pending' },
            events: [completed],
          };
        case 'review':
          return completeReview(job, ctx, blocking, completed);
        case 'approve': {
          // decision.md carries DECISION: APPROVE | ESCALATE | REWORK-BUILD | REWORK-SPEC; only an
          // approval advances.
          if (artifact?.marker !== 'approve') {
            const use = scopeGapTarget(artifact?.marker) ? 'rework' : 'escalate';
            reject(`decision.md says ${(artifact?.marker ?? 'nothing').toUpperCase()}; use ${use}`);
          }
          // An approval cannot step over findings the last review round counted as blocking.
          if (blocking > 0) {
            reject(
              `round-${String(job.round)}/consolidated.md still counts ${String(blocking)} blocking finding(s); use escalate`,
            );
          }
          return { patch: { stage: 'pr', status: 'pending' }, events: [completed] };
        }
        case 'pr': {
          if (!job.prUrl) reject('record the PR first (orch job pr)');
          // Reaching pr by a human `--to pr` is allowed; finishing without an approval is not,
          // except under `ci`, whose pre-review pass has none yet (the delivery gate decides).
          if (!ciFirst && !approvalEvidence(mode, ctx.artifacts)) {
            reject(`no ${approvalName(mode)} is registered`);
          }
          return { patch: { stage: 'ci', status: 'pending' }, events: [completed] };
        }
        case 'ci': {
          // Only GitHub's verdict for the PR head counts; `orch gh ci` is what records it.
          if (!job.prUrl) reject('no PR is recorded');
          if (job.prState === 'closed') reject('the PR was closed without merging');
          if (!job.ciHead) {
            // `pr create` and `pr status` record the rollup without a head: not a verdict.
            reject('no CI verdict has been read for the PR head; run orch gh ci');
          }
          // A human merged the PR at the verified, approved HEAD before the checks finished.
          const merged = ctx.mergedByHuman === true;
          const preReview = ciFirst && ctx.approved !== true;
          if (merged && preReview) reject('a PR merged before review cannot complete the job');
          if (merged && job.prState !== 'merged') reject('the PR is not recorded as merged');
          if (!merged && job.ciStatus !== 'passing') {
            reject(
              `required checks are ${job.ciStatus ?? 'not observed'} for the PR head; run orch gh ci`,
            );
          }
          if (preReview) {
            // The pre-review pass: CI passed for this exact commit, so reviewers may judge it.
            return {
              patch: { stage: 'review', status: 'pending' },
              events: [{ ...completed, payload: { ...completed.payload, head: job.ciHead } }],
            };
          }
          const payload = {
            prUrl: job.prUrl,
            head: job.ciHead,
            ...(merged && {
              ciStatus: job.ciStatus,
              mergedByHuman: true,
              reason: 'merged by a human before CI finished',
            }),
          };
          return {
            patch: { stage: 'completed', status: 'completed', completedAt: now() },
            events: [completed, { type: 'job.completed', payload }],
          };
        }
        default:
          return reject('stage has no completion');
      }
    }

    case 'fail': {
      if (status !== 'running') reject('stage is not running');
      return {
        patch: { status: 'failed' },
        events: [{ type: 'stage.failed', payload: { stage, reason: ctx.reason ?? null } }],
      };
    }

    case 'escalate': {
      if (stage === 'needs-human') reject('already escalated');
      // A job's mode never changes, so a choice refused here could never be answered later.
      const unreachable = ctx.choices?.find((c) => c.to && !FAST_RESUME_TARGETS.includes(c.to));
      if (job.mode === 'fast' && unreachable) {
        reject(
          `choice "${unreachable.label}" resumes to ${String(unreachable.to)}, but a fast job ` +
            `resumes only to ${FAST_RESUME_TARGETS.join(', ')}`,
        );
      }
      const payload = { from: stage, reason: ctx.reason ?? null };
      return {
        patch: { stage: 'needs-human', status: 'blocked', returnStage: stage },
        events: [
          {
            type: 'job.blocked',
            payload: ctx.choices ? { ...payload, choices: ctx.choices } : payload,
          },
        ],
      };
    }

    case 'resume': {
      if (stage === 'needs-human') {
        const to = ctx.to ?? job.returnStage;
        // A fast job never visits spec, simplify, review, or approve; converting it is not resuming.
        if (job.mode === 'fast' && to && !FAST_RESUME_TARGETS.includes(to)) {
          reject(
            `a fast job resumes only to ${FAST_RESUME_TARGETS.join(', ')}; ` +
              'cancel the job and `orch ticket reopen` it to run the full workflow',
          );
        }
        if (to === 'completed') return acceptDelivery(job, ctx);
        if (!to || to === 'needs-human') reject('specify --to <stage>');
        // Leaving a spec escalation for a later stage skips nothing: an unanswered REWORK-SPEC
        // and the challenge gate both hold, in the order `complete` from spec checks them.
        if (job.returnStage === 'spec' && to !== 'spec') {
          const refused =
            scopeGapSpecRefusal(ctx.artifacts) ?? specChallengeRefusal(ctx.artifacts, true);
          if (refused) reject(refused);
        }
        // A simplify or review requested from needs-human is a fresh round, as after a build:
        // earlier verdicts stay as that round's history instead of being shown or overwritten.
        const opensRound = to === 'review' || to === 'simplify';
        // A human sending the job to build, simplify, or review grants the round it leads to:
        // recorded as a raised maxRounds, so `round / maxRounds` stays truthful.
        const maxRounds = opensRound || to === 'build' ? { maxRounds: job.maxRounds + 1 } : {};
        return {
          patch: {
            stage: to,
            status: 'pending',
            returnStage: null,
            ...(opensRound ? { round: job.round + 1 } : {}),
            ...maxRounds,
          },
          events: [{ type: 'job.resumed', payload: { to, ...maxRounds } }],
        };
      }
      if (!RESUMABLE_STATUSES.includes(status)) reject('nothing to resume');
      return {
        patch: { status: 'pending' },
        events: [{ type: 'job.resumed', payload: { stage } }],
      };
    }

    case 'rework': {
      // Base integration needed the builder (conflicts or edits inside the merge), or CI failed on
      // the delivered commit: the result is new code, so it goes through build, review, and
      // approval again, then is pushed to the same PR. Approve joins pr because the base often
      // moves during approval. CI repairs are bounded per job. None of these is review-driven, so
      // the round it opens raises maxRounds instead of spending it.
      if (stage !== 'approve' && stage !== 'pr' && stage !== 'ci')
        reject('rework is only for the approve, pr and ci stages');
      const maxRounds = job.maxRounds + 1;
      // A base conflict is not a CI failure: integration reworks from ci without spending a repair.
      const integration = ctx.integration === true;
      const reworked = {
        type: 'job.reworked',
        payload: {
          from: stage,
          reason: ctx.reason ?? null,
          ciRepairs: job.ciRepairs,
          maxRounds,
          ...(integration ? { integration: true } : {}),
        },
      };
      if (stage === 'approve' && !integration) {
        // A scope gap the approver recorded: code less than the spec goes back to build, a spec
        // less than the request to spec. One automatic scope rework per job; then a human decides.
        const decision = ctx.artifacts.find((a) => a.path === 'decision.md')?.marker;
        const to = scopeGapTarget(decision);
        if (!to) {
          reject(
            `decision.md says ${(decision ?? 'nothing').toUpperCase()}; rework from approve needs DECISION: REWORK-BUILD or REWORK-SPEC`,
          );
        }
        if (job.scopeReworks >= 1) {
          return {
            patch: { stage: 'needs-human', status: 'blocked', returnStage: to },
            events: [
              {
                type: 'job.blocked',
                payload: { from: stage, reason: SCOPE_GAP_REASON, detail: ctx.reason ?? null },
              },
            ],
          };
        }
        return {
          patch: { stage: to, status: 'pending', maxRounds, scopeReworks: job.scopeReworks + 1 },
          events: [{ ...reworked, payload: { ...reworked.payload, scopeGap: to } }],
        };
      }
      if (stage !== 'ci' || integration)
        return { patch: { stage: 'build', status: 'pending', maxRounds }, events: [reworked] };
      if (job.ciRepairs >= job.maxCiRepairs) {
        return {
          patch: { stage: 'needs-human', status: 'blocked', returnStage: 'build' },
          events: [
            {
              type: 'job.blocked',
              payload: { from: stage, reason: MAX_CI_REPAIRS_REASON, detail: ctx.reason ?? null },
            },
          ],
        };
      }
      return {
        patch: { stage: 'build', status: 'pending', ciRepairs: job.ciRepairs + 1, maxRounds },
        events: [{ ...reworked, payload: { ...reworked.payload, ciRepairs: job.ciRepairs + 1 } }],
      };
    }

    case 'cancel': {
      if (status === 'cancelled') reject('already cancelled');
      if (status === 'completed') reject('job is finished');
      return {
        patch: { status: 'cancelled', completedAt: now() },
        events: [{ type: 'job.cancelled', payload: { stage, reason: ctx.reason ?? null } }],
      };
    }
  }
}

/**
 * Why a human may not close out this job as delivered (`resume --to completed`), or null when
 * they may: only a job escalated from the ci stage, with an observed PR head, whose PR either
 * reported no checks at all or was merged outside the factory. A failing or pending CI result can
 * never be accepted this way. The dashboard lists the action from this same rule.
 */
export function cannotAcceptDelivery(
  job: Pick<JobState, 'stage' | 'returnStage' | 'prUrl' | 'ciHead' | 'ciStatus' | 'prState'>,
): string | null {
  if (job.stage !== 'needs-human' || job.returnStage !== 'ci') {
    return 'only a job escalated from the ci stage can be closed out';
  }
  if (!job.prUrl || !job.ciHead) return 'no PR head has been observed';
  if (job.prState === 'closed')
    return 'the PR was closed without merging; reopen it or cancel the job';
  if (job.ciStatus !== 'none' && job.prState !== 'merged') {
    return `required checks are ${job.ciStatus ?? 'not observed'}; fix CI and resume --to ci instead`;
  }
  return null;
}

/**
 * How a completed job finished, from its `job.completed` event payload: GitHub's verdict for a
 * head (`ci`), a human merge of the PR at the verified head before CI finished (`merged`), a
 * human close-out (`human`), or before the ci stage existed (`legacy`). Null while the job is not
 * completed.
 */
export type Completion = 'ci' | 'merged' | 'human' | 'legacy' | null;

export function completionOf(
  stage: Stage,
  completed: Record<string, unknown> | undefined,
): Completion {
  if (stage !== 'completed') return null;
  if (completed?.['acceptedByHuman'] === true) return 'human';
  if (completed?.['mergedByHuman'] === true) return 'merged';
  return typeof completed?.['head'] === 'string' ? 'ci' : 'legacy';
}

/** Where the PR stands in delivery, from persisted fields only (never GitHub's live answer). */
export const PR_PHASES = [
  'no-pr',
  'draft',
  'ci-running',
  'ci-failing',
  'ready-to-merge',
  'ready-mark-failed',
  'merged',
  'closed',
] as const;
export type PrPhase = (typeof PR_PHASES)[number];

export function prPhase(
  job: Pick<JobState, 'prUrl' | 'prState' | 'ciStatus'>,
  completion: Completion,
): PrPhase {
  if (!job.prUrl) return 'no-pr';
  if (job.prState === 'merged') return 'merged';
  if (job.prState === 'closed') return 'closed';
  if (completion === 'ci' && job.prState === 'ready' && job.ciStatus === 'passing') {
    return 'ready-to-merge';
  }
  if (completion === 'ci' && job.prState === 'draft') return 'ready-mark-failed';
  if (job.ciStatus === 'pending') return 'ci-running';
  if (job.ciStatus === 'failing') return 'ci-failing';
  return 'draft';
}

/**
 * Why the dashboard may not merge this job's PR, or null when it may: only a job GitHub's verdict
 * completed, whose PR orch marked ready, with that verdict passing for a recorded head. GitHub's
 * live state is checked again when the merge is requested.
 */
export function cannotMerge(
  job: Pick<Job, 'stage' | 'prUrl' | 'prState' | 'ciStatus' | 'ciHead' | 'supersededBy'>,
  completion: Completion,
): string | null {
  if (job.stage !== 'completed') return 'only a completed job can be merged';
  if (completion !== 'ci') return 'only a job completed on a passing CI verdict can be merged';
  if (!job.prUrl || !job.ciHead) return 'no PR head has been recorded';
  if (job.supersededBy) return `${job.supersededBy} superseded this job; merge that one`;
  if (job.prState !== 'ready')
    return `the PR is ${job.prState ?? 'in an unknown state'}, not ready`;
  if (job.ciStatus !== 'passing') return `CI is ${job.ciStatus ?? 'not observed'}, not passing`;
  return null;
}

/** Why a merge is refused; each is a state someone has to change before a retry can differ. */
export const MERGE_BLOCKS = [
  'no-pr',
  'not-completed',
  'wrong-completion',
  'no-ci-evidence',
  'superseded',
  'wrong-repository',
  'wrong-base',
  'wrong-head-branch',
  'pr-closed',
  'pr-draft',
  'head-changed',
  'workflow-changed',
  'not-authorized',
  'conflict',
  'second-conflict',
  'reland-refused',
  'github-refused',
] as const;
export type MergeBlock = (typeof MERGE_BLOCKS)[number];

/**
 * The merge refusals only a person can lift on this one ticket, each with the step that person
 * takes. The factory controller reports such a ticket as needs-human instead of blocked
 * (decision 2026-11-23-queue-passes-over-person-merge-blocks); whether its run goes on is
 * `endsRun`'s answer.
 */
const PERSON_MERGE_STEPS = {
  'workflow-changed': (job: string) =>
    `merge job ${job}'s PR with Merge on the dashboard (orch ui): it changes .github/workflows/, so only a human click merges it`,
  'not-authorized': (job: string, key: string) =>
    `merge job ${job}'s PR with Merge on the dashboard (orch ui), or enable merging with orch factory config merge enable --repo <path>, then orch do ${key}`,
  'head-changed': (job: string, key: string) =>
    `remove the commits nobody verified from job ${job}'s PR branch, then orch do ${key}`,
  'pr-closed': (job: string, key: string) =>
    `reopen job ${job}'s PR on GitHub, then orch do ${key}`,
  'pr-draft': (job: string, key: string) =>
    `mark job ${job}'s PR ready for review on GitHub, then orch do ${key}`,
  'second-conflict': (job: string, key: string) =>
    `resolve job ${job}'s conflict with its base by hand (no third job is started), merge it, then orch ticket done ${key}`,
} satisfies Partial<Record<MergeBlock, (job: string, key: string) => string>>;

/** The step a person takes for a merge refused with `code`, or null when no person can lift it. */
export function personMergeStep(code: string, jobId: string, ticketKey: string): string | null {
  return Object.hasOwn(PERSON_MERGE_STEPS, code)
    ? PERSON_MERGE_STEPS[code as keyof typeof PERSON_MERGE_STEPS](jobId, ticketKey)
    : null;
}

/**
 * The stop codes of a ticket result that would hit every ticket, so the factory controller's
 * queue ends on them: claude cannot start, GitHub cannot be read, answers nothing, or refuses
 * the merge call. Any other code, including one added later, concerns only its ticket: it is
 * reported and passed over, and the queue goes on (decision
 * 2026-11-23-queue-ends-only-on-run-wide-outcomes). A stop request and a lost lock end the run
 * on their own and are not ticket codes.
 */
export const RUN_ENDING_CODES: readonly string[] = [
  'claude-failed',
  'github-unreadable',
  'merge-no-answer',
  'github-refused',
];

/** Whether a ticket that ended with `code` ends the controller's run; no code never does. */
export function endsRun(code: string | undefined): boolean {
  return code !== undefined && RUN_ENDING_CODES.includes(code);
}

/** What GitHub says about the PR right now (a `GhPr`; restated here so this module stays pure). */
export interface LivePr {
  url: string;
  /** OPEN, MERGED, or CLOSED. */
  state: string;
  isDraft: boolean;
  /** Repository the PR belongs to, in the form of `job.repo`. */
  repo: string;
  /** The head branch lives in another repository (a fork). */
  isCrossRepository: boolean;
  baseRefName: string;
  headRefName: string;
  headSha: string | null;
  mergeable: string | null;
}

export type MergeStep =
  /** GitHub already reports the PR merged: record it. `verified` when the merged head is `ciHead`. */
  | { step: 'record'; verified: boolean; reason: string | null }
  | { step: 'merge'; head: string }
  | { step: 'wait'; reason: string }
  | { step: 'reland'; reason: string }
  | { step: 'blocked'; code: MergeBlock; reason: string };

export interface MergeFacts {
  completion: Completion;
  /** The caller may start a merge: a human at the dashboard, or a repository opted in locally. */
  authorized: boolean;
  /** This job already replaced another one, so a conflict here is the second. */
  isReland: boolean;
  /**
   * GitHub's file list for the PR touches `.github/workflows/`, or that list could not be read in
   * full. Such a PR changed what CI runs, so only a human's click merges it
   * (decision 2026-11-22-workflow-changes-need-a-human-merge).
   */
  changesWorkflows: boolean;
  /** The merge is a human's dashboard click. */
  byHuman: boolean;
}

/**
 * True when any of `paths` (repository-relative, `/` or `\`) is under `.github/workflows/`, or is
 * exactly `.github/workflows` or `.github`: how a symlink or gitlink that replaces either
 * directory appears in a PR's file list.
 */
export function touchesWorkflows(paths: readonly string[]): boolean {
  return paths.some((p) => {
    const n = p
      .split('\\')
      .join('/')
      .replace(/^\.\/+/, '')
      .toLowerCase();
    return n.startsWith('.github/workflows/') || n === '.github/workflows' || n === '.github';
  });
}

/**
 * The one rule for merging a job's PR, from the job row and GitHub's fresh answer; nothing stored
 * about the PR is trusted. Identity comes first, so nothing is recorded or merged for a PR that is
 * not the job's own; a PR GitHub already merged is then only recorded (no authorization needed);
 * everything after that guards a new merge of exactly `ciHead`.
 */
export function mergeDecision(
  job: Pick<
    Job,
    'stage' | 'repo' | 'baseBranch' | 'branch' | 'ciStatus' | 'ciHead' | 'supersededBy'
  >,
  pr: LivePr,
  facts: MergeFacts,
): MergeStep {
  const blocked = (code: MergeBlock, reason: string): MergeStep => ({
    step: 'blocked',
    code,
    reason,
  });
  const short = (sha: string | null) => sha?.slice(0, 7) ?? '?';
  if (pr.repo !== job.repo) {
    return blocked(
      'wrong-repository',
      `${pr.url} belongs to ${pr.repo}, not the job's ${job.repo}`,
    );
  }
  if (pr.baseRefName !== job.baseBranch) {
    return blocked(
      'wrong-base',
      `${pr.url} targets ${pr.baseRefName}, not the job's base ${job.baseBranch}`,
    );
  }
  if (pr.isCrossRepository || pr.headRefName !== job.branch) {
    return blocked(
      'wrong-head-branch',
      `${pr.url} is from ${pr.isCrossRepository ? 'a fork, ' : ''}${pr.headRefName}, not the job's branch ${job.branch ?? '(none)'}`,
    );
  }
  if (job.stage !== 'completed') {
    return blocked('not-completed', `the job is in ${job.stage}; only a completed job is merged`);
  }
  const evidence =
    facts.completion === 'ci' && job.ciStatus === 'passing' && job.ciHead !== null
      ? job.ciHead
      : null;
  if (pr.state === 'MERGED') {
    const verified = evidence !== null && pr.headSha === evidence;
    return {
      step: 'record',
      verified,
      reason: verified
        ? null
        : evidence === null
          ? 'the PR is merged, but the job has no passing CI verdict of its own to compare with'
          : `the PR was merged at ${short(pr.headSha)}, not the verified ${short(evidence)}`,
    };
  }
  if (facts.completion !== 'ci') {
    return blocked(
      'wrong-completion',
      'the job was not completed by a passing CI verdict (a human closed it out, or merged first)',
    );
  }
  if (evidence === null) {
    return blocked(
      'no-ci-evidence',
      `no passing CI verdict is recorded for a PR head (CI is ${job.ciStatus ?? 'not observed'})`,
    );
  }
  if (job.supersededBy !== null) {
    return blocked('superseded', `${job.supersededBy} superseded this job; its PR must not merge`);
  }
  if (pr.state !== 'OPEN') return blocked('pr-closed', `GitHub reports the PR ${pr.state}`);
  if (pr.isDraft) return blocked('pr-draft', 'the PR is a draft on GitHub');
  if (pr.headSha !== evidence) {
    return blocked(
      'head-changed',
      `the PR head is ${short(pr.headSha)}, not the verified ${short(evidence)}: commits nobody verified`,
    );
  }
  if (facts.changesWorkflows && !facts.byHuman) {
    return blocked(
      'workflow-changed',
      'the PR changes .github/workflows/ (or that could not be checked), which decides what CI runs; ' +
        'only a human merges it (Merge on the dashboard)',
    );
  }
  if (!facts.authorized) {
    return blocked(
      'not-authorized',
      `merging without a human click is not enabled for ${job.repo}; enable it with orch factory config merge enable --repo <path>`,
    );
  }
  if (pr.mergeable === 'CONFLICTING') {
    return facts.isReland
      ? blocked(
          'second-conflict',
          `the re-land conflicts with ${job.baseBranch} again; no third job is started`,
        )
      : { step: 'reland', reason: `GitHub reports the PR CONFLICTING with ${job.baseBranch}` };
  }
  if (pr.mergeable !== 'MERGEABLE') {
    return {
      step: 'wait',
      reason: `GitHub reports mergeability ${pr.mergeable ?? 'UNKNOWN'} (still computing); try again shortly`,
    };
  }
  return { step: 'merge', head: evidence };
}

/**
 * Why the dashboard may not re-read the PR from GitHub, or null when it may: a recorded, unmerged
 * PR on a finished job or one waiting in needs-human (a running ci job reads it with orch gh ci).
 */
export function cannotRefreshPr(
  job: Pick<JobState, 'stage' | 'status' | 'prUrl' | 'prState'>,
): string | null {
  if (!job.prUrl) return 'no PR is recorded';
  if (job.prState === 'merged') return 'the PR is already merged';
  if (!TERMINAL_STATUSES.includes(job.status) && job.stage !== 'needs-human') {
    return 'only a finished job or one waiting in needs-human is refreshed from here';
  }
  return null;
}

function acceptDelivery(job: JobState, ctx: TransitionContext): TransitionResult {
  const refused = cannotAcceptDelivery(job);
  if (refused) throw new WorkflowError(`Cannot resume job to completed: ${refused}`);
  return {
    patch: { stage: 'completed', status: 'completed', returnStage: null, completedAt: now() },
    events: [
      { type: 'job.resumed', payload: { to: 'completed' } },
      {
        type: 'job.completed',
        payload: {
          prUrl: job.prUrl,
          head: job.ciHead,
          ciStatus: job.ciStatus,
          acceptedByHuman: true,
          reason: ctx.reason ?? null,
        },
      },
    ],
  };
}

function currentReviews(job: Pick<JobState, 'round'>, reviews: Review[]): Review[] {
  return reviews.filter((r) => r.round === job.round);
}

/** Reviewers every round needs, whatever else runs (UI reviewers join only for UI changes). */
export const REQUIRED_REVIEWERS: readonly string[] = ROLES.filter(
  (r) => r.kind === 'review' && !r.ui,
).map((r) => r.name);

function verifyReviewers(current: Review[]): void {
  if (current.length === 0) throw new WorkflowError('No reviewers recorded for this round');
  const pending = current.filter((r) => r.verdict === null).map((r) => r.reviewer);
  if (pending.length > 0) {
    throw new WorkflowError(`Reviewers still pending: ${pending.join(', ')}`);
  }
  const missing = REQUIRED_REVIEWERS.filter((name) => !current.some((r) => r.reviewer === name));
  if (missing.length > 0) {
    throw new WorkflowError(`Required reviewers not recorded this round: ${missing.join(', ')}`);
  }
  // Every verdict in a round must have been given against the same commit.
  const heads = new Set(current.map((r) => r.head));
  if (heads.size > 1) {
    const list = current.map((r) => `${r.reviewer}@${r.head?.slice(0, 7) ?? 'none'}`).join(', ');
    throw new WorkflowError(`Reviewers evaluated different commits (${list}); rerun the round`);
  }
}

/** BLOCKING count from the round's consolidated.md, 0 when there is none. */
export function blockingCount(artifacts: Artifact[], round: number): number {
  const a = artifacts.find((x) => x.path === `round-${String(round)}/consolidated.md`);
  const n = Number(a?.marker ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function completeReview(
  job: JobState,
  ctx: TransitionContext,
  blocking: number,
  completed: TransitionResult['events'][number],
): TransitionResult {
  const current = currentReviews(job, ctx.reviews);
  const changes = current.filter((r) => r.verdict === 'changes').map((r) => r.reviewer);
  const payload = { ...completed.payload, changesRequestedBy: changes, blocking };
  // Blocking findings in the consolidation send the job back even when every verdict passed.
  if (changes.length === 0 && blocking === 0) {
    return { patch: { stage: 'approve', status: 'pending' }, events: [{ ...completed, payload }] };
  }
  // The last allowed round rejected: escalate instead of building again. CI repairs, base
  // rework, and human resumes raised maxRounds for the rounds they opened, so this counts
  // review-driven rounds only.
  if (job.round >= job.maxRounds) {
    return {
      patch: { stage: 'needs-human', status: 'blocked', returnStage: 'build' },
      events: [
        { ...completed, payload },
        { type: 'job.blocked', payload: { from: 'review', reason: MAX_ROUNDS_REASON } },
      ],
    };
  }
  return { patch: { stage: 'build', status: 'pending' }, events: [{ ...completed, payload }] };
}

export function now(): string {
  return new Date().toISOString();
}
