/**
 * The workflow contract: stages, statuses, and the pure transition function.
 *
 * Claude requests a transition; this module decides whether it is legal given the job and its
 * registered results, and returns the new job fields plus the events to append. It performs no
 * I/O. `src/storage/jobs.ts` applies the result inside a transaction.
 */
import { WorkflowError } from './errors.ts';
import type { Artifact, Job, Review } from '../storage/schema.ts';

export const STAGES = [
  'spec',
  'build',
  'review',
  'approve',
  'pr',
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

export const VERDICTS = ['pass', 'changes'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const PR_STATES = ['draft', 'ready', 'merged'] as const;
export type PrState = (typeof PR_STATES)[number];

/** Rollup of a PR's checks: `none` when the PR has no checks configured. */
export const CI_STATUSES = ['pending', 'passing', 'failing', 'none'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export const ACTIONS = ['start', 'complete', 'fail', 'escalate', 'resume', 'cancel'] as const;
export type Action = (typeof ACTIONS)[number];

export const TERMINAL_STATUSES: readonly Status[] = ['completed', 'cancelled'];

/** Artifact a stage must register (relative to the job artifact dir) before it can complete. */
export function requiredArtifact(stage: Stage, round: number): string | undefined {
  switch (stage) {
    case 'spec':
      return 'spec.md';
    case 'build':
      return 'build.md';
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

export function reviewArtifact(round: number, reviewer: string): string {
  return `round-${String(round)}/review-${reviewer}.md`;
}

export interface Next {
  stage: Stage;
  status: Status;
  requiredArtifacts: string[];
  /** Present when the stage is review. */
  round?: number;
}

export function describeNext(job: Pick<Job, 'stage' | 'status' | 'round'>): Next {
  const required = requiredArtifact(job.stage, job.round);
  const next: Next = {
    stage: job.stage,
    status: job.status,
    requiredArtifacts: required ? [required] : [],
  };
  if (job.stage === 'review') next.round = job.round;
  return next;
}

export interface TransitionContext {
  artifacts: Artifact[];
  reviews: Review[];
  /** Target stage when resuming from needs-human. */
  to?: Stage | undefined;
  reason?: string | undefined;
}

export interface TransitionResult {
  patch: Partial<Job>;
  events: { type: string; payload: Record<string, unknown> }[];
}

type JobState = Pick<
  Job,
  'stage' | 'status' | 'round' | 'maxRounds' | 'returnStage' | 'prUrl' | 'prState'
>;

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
        patch: { status: 'running' },
        events: [{ type: 'stage.started', payload: { stage } }],
      };
    }

    case 'complete': {
      if (status !== 'running') reject('stage is not running');
      // Reviewer completeness is reported before the consolidated artifact, since it comes first.
      if (stage === 'review') verifyReviewers(currentReviews(job, ctx.reviews));
      const required = requiredArtifact(stage, job.round);
      const artifact = required ? ctx.artifacts.find((a) => a.path === required) : undefined;
      if (required && !artifact) reject(`missing required artifact ${required}`);
      const completed = { type: 'stage.completed', payload: { stage, round: job.round } };
      switch (stage) {
        case 'spec':
          return { patch: { stage: 'build', status: 'pending' }, events: [completed] };
        case 'build':
          return {
            patch: { stage: 'review', status: 'pending', round: job.round + 1 },
            events: [completed],
          };
        case 'review':
          return completeReview(job, ctx.reviews, completed);
        case 'approve': {
          // decision.md carries DECISION: APPROVE | ESCALATE; only an approval advances.
          if (artifact?.marker !== 'approve') {
            reject(
              `decision.md says ${(artifact?.marker ?? 'nothing').toUpperCase()}; use escalate`,
            );
          }
          return { patch: { stage: 'pr', status: 'pending' }, events: [completed] };
        }
        case 'pr': {
          if (!job.prUrl) reject('record the PR first (orch job pr)');
          return {
            patch: { stage: 'completed', status: 'completed', completedAt: now() },
            events: [completed, { type: 'job.completed', payload: { prUrl: job.prUrl } }],
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
      return {
        patch: { stage: 'needs-human', status: 'blocked', returnStage: stage },
        events: [{ type: 'job.blocked', payload: { from: stage, reason: ctx.reason ?? null } }],
      };
    }

    case 'resume': {
      if (stage === 'needs-human') {
        const to = ctx.to ?? job.returnStage;
        if (!to || to === 'needs-human' || to === 'completed') reject('specify --to <stage>');
        return {
          patch: { stage: to, status: 'pending', returnStage: null },
          events: [{ type: 'job.resumed', payload: { to } }],
        };
      }
      if (!['interrupted', 'failed', 'blocked'].includes(status)) reject('nothing to resume');
      return {
        patch: { status: 'pending' },
        events: [{ type: 'job.resumed', payload: { stage } }],
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

function currentReviews(job: Pick<JobState, 'round'>, reviews: Review[]): Review[] {
  return reviews.filter((r) => r.round === job.round);
}

function verifyReviewers(current: Review[]): void {
  if (current.length === 0) throw new WorkflowError('No reviewers recorded for this round');
  const pending = current.filter((r) => r.verdict === null).map((r) => r.reviewer);
  if (pending.length > 0) {
    throw new WorkflowError(`Reviewers still pending: ${pending.join(', ')}`);
  }
}

function completeReview(
  job: JobState,
  reviews: Review[],
  completed: TransitionResult['events'][number],
): TransitionResult {
  const current = currentReviews(job, reviews);
  const changes = current.filter((r) => r.verdict === 'changes').map((r) => r.reviewer);
  const payload = { ...completed.payload, changesRequestedBy: changes };
  if (changes.length === 0) {
    return { patch: { stage: 'approve', status: 'pending' }, events: [{ ...completed, payload }] };
  }
  if (job.round >= job.maxRounds) {
    return {
      patch: { stage: 'needs-human', status: 'blocked', returnStage: 'build' },
      events: [
        { ...completed, payload },
        { type: 'job.blocked', payload: { from: 'review', reason: 'max review rounds reached' } },
      ],
    };
  }
  return { patch: { stage: 'build', status: 'pending' }, events: [{ ...completed, payload }] };
}

export function now(): string {
  return new Date().toISOString();
}
