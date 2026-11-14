/**
 * Pure derivations for the dashboard: execution state, the reason a job is not progressing, and
 * whether a session may resume it. Inputs are persisted rows only; the reason text shown is the
 * recorded one, verbatim, never parsed or guessed.
 */
import { leaseExpired } from '../core/ownership.ts';
import { blockingCount, MAX_CI_REPAIRS_REASON, MAX_ROUNDS_REASON, now } from '../core/workflow.ts';
import type { Artifact, Event, Job, VerificationRun } from '../storage/schema.ts';
import type { Blocker, CiView, Liveness, Resume } from './types.ts';

type Lease = Pick<Job, 'status' | 'stage' | 'leaseExpiresAt' | 'ownerSession'>;

export function liveness(job: Lease): Liveness {
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'completed') return 'completed';
  if (job.stage === 'needs-human' || job.status === 'blocked') return 'blocked';
  if (job.status === 'failed') return 'failed';
  if (job.status === 'interrupted') return 'interrupted';
  if (job.status === 'running') return leaseExpired(job, now()) ? 'stale' : 'running';
  return 'idle';
}

/** Event types whose newest occurrence explains a stopped job or its CI state. */
export const BLOCKER_EVENTS = [
  'job.blocked',
  'stage.failed',
  'job.interrupted',
  'job.cancelled',
  'ci.observed',
  'job.completed',
] as const;

export interface Evidence {
  /** Newest event per type, for the types in BLOCKER_EVENTS. */
  events: Map<string, Event>;
  artifacts: Artifact[];
  latestRun: VerificationRun | null;
}

function text(e: Event | undefined, key: string): string | null {
  const v = e?.payload[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function verificationFailed(run: VerificationRun | null, detail: string | null): Blocker | null {
  if (run?.status !== 'failed') return null;
  return {
    kind: 'verification',
    summary: `Verification failed at ${run.head.slice(0, 7)}`,
    detail,
  };
}

/** What the newest `orch gh ci` reconciliation concluded, when the newest observation is one. */
function lastOutcome(e: Event | undefined): string | null {
  return text(e, 'outcome');
}

/** One line for a ci-stage escalation, from the recorded reason code and the last CI outcome. */
function ciBlocker(
  job: Pick<Job, 'ciRepairs' | 'maxCiRepairs'>,
  blocked: Event | undefined,
  observed: Event | undefined,
): Blocker {
  const reason = text(blocked, 'reason');
  if (reason === MAX_CI_REPAIRS_REASON) {
    return {
      kind: 'ci',
      summary: `CI still failing after ${String(job.ciRepairs)} of ${String(job.maxCiRepairs)} repair cycles`,
      detail: text(blocked, 'detail'),
    };
  }
  const summaries: Record<string, string> = {
    closed: 'PR was closed without merging',
    outdated: 'PR head moved outside the job',
    none: 'GitHub reports no checks for the PR head',
    infrastructure: 'Required checks did not reach a verdict',
  };
  const outcome = lastOutcome(observed);
  return {
    kind: 'ci',
    summary: (outcome !== null ? summaries[outcome] : undefined) ?? 'Escalated from ci',
    detail: reason,
  };
}

export function blockerOf(
  job: Lease & Pick<Job, 'round' | 'ciRepairs' | 'maxCiRepairs'>,
  state: Liveness,
  ev: Evidence,
): Blocker | null {
  switch (state) {
    case 'running':
    case 'completed':
      return null;
    case 'cancelled': {
      const e = ev.events.get('job.cancelled');
      return {
        kind: 'cancelled',
        summary: `Cancelled during ${job.stage}${e?.actor ? ` by ${e.actor}` : ''}`,
        detail: text(e, 'reason'),
      };
    }
    case 'stale':
      return {
        kind: 'interrupted',
        summary: `Session ${job.ownerSession ?? '?'} stopped renewing its lease; presumed gone`,
        detail: null,
      };
    case 'interrupted': {
      const prev = text(ev.events.get('job.interrupted'), 'previousSession');
      return {
        kind: 'interrupted',
        summary: `Interrupted while running${prev ? ` under session ${prev}` : ''}`,
        detail: null,
      };
    }
    case 'failed': {
      const reason = text(ev.events.get('stage.failed'), 'reason');
      return (
        verificationFailed(ev.latestRun, reason) ?? {
          kind: 'failed',
          summary: `Stage ${job.stage} failed`,
          detail: reason,
        }
      );
    }
    case 'blocked': {
      const e = ev.events.get('job.blocked');
      const from = text(e, 'from');
      const reason = text(e, 'reason');
      if (from === 'review' && reason === MAX_ROUNDS_REASON) {
        const n = blockingCount(ev.artifacts, job.round);
        return {
          kind: 'findings',
          summary:
            n > 0
              ? `${String(n)} blocking finding(s) remain after the last allowed review round`
              : 'Reviewers still request changes after the last allowed review round',
          detail: null,
        };
      }
      if (from === 'ci') return ciBlocker(job, e, ev.events.get('ci.observed'));
      const decision = ev.artifacts.find((a) => a.path === 'decision.md')?.marker;
      if (from === 'approve' && decision === 'escalate') {
        return {
          kind: 'decision',
          summary: 'Approver escalated: a human must decide',
          detail: reason,
        };
      }
      return (
        verificationFailed(ev.latestRun, reason) ?? {
          kind: 'escalated',
          summary: from ? `Escalated from ${from}` : 'Escalated',
          detail: reason,
        }
      );
    }
    case 'idle': {
      if (job.ownerSession === null) {
        return { kind: 'waiting', summary: 'No session owns this job', detail: null };
      }
      if (leaseExpired(job, now())) {
        return {
          kind: 'waiting',
          summary: `Lease held by ${job.ownerSession} lapsed; presumed gone`,
          detail: null,
        };
      }
      return null;
    }
  }
}

type CiRow = Pick<
  Job,
  'stage' | 'ciHead' | 'ciStatus' | 'ciCheckedAt' | 'ciRepairs' | 'maxCiRepairs'
>;

/**
 * The CI state to show, from the job row and the newest `ci.observed` / `job.completed` events.
 * `head` is the worktree HEAD when the caller inspected it (null or undefined when it could not);
 * the rollup is "current" only when it describes that commit, so an old green verdict is never
 * shown as current after the head moved.
 */
export function ciView(
  job: CiRow,
  events: Map<string, Event>,
  head: string | null | undefined,
): CiView {
  const observed = events.get('ci.observed');
  // A reconciliation outcome counts only when the observation describes the recorded head.
  const forHead = observed && text(observed, 'head') === job.ciHead ? observed : undefined;
  const failures = Array.isArray(forHead?.payload['failures'])
    ? (forHead.payload['failures'] as CiView['failures'])
    : [];
  const completed = events.get('job.completed');
  let completion: CiView['completion'] = null;
  if (job.stage === 'completed') {
    completion =
      completed?.payload['acceptedByHuman'] === true
        ? 'human'
        : typeof completed?.payload['head'] === 'string'
          ? 'ci'
          : 'legacy';
  }
  return {
    head: job.ciHead,
    current: head == null ? null : job.ciHead !== null && job.ciHead === head,
    status: job.ciStatus,
    checkedAt: job.ciCheckedAt,
    repairs: job.ciRepairs,
    maxRepairs: job.maxCiRepairs,
    outcome: lastOutcome(forHead),
    reason: text(forHead, 'reason'),
    failures,
    completion,
  };
}

/**
 * Whether a Claude Code session may resume the job now. Null for finished jobs (the workflow
 * refuses). A live lease, whoever holds it, means `orch factory resume` would be refused without
 * a deliberate `--force` from that session's owner, so the command is withheld and the holder is
 * named instead; a lapsed lease is the normal resume case. Nothing here changes ownership.
 */
export function resumeOf(job: Lease & Pick<Job, 'id'>, state: Liveness): Resume | null {
  if (state === 'completed' || state === 'cancelled') return null;
  if (job.ownerSession !== null && !leaseExpired(job, now())) {
    return {
      command: null,
      heldBy: { session: job.ownerSession, leaseExpiresAt: job.leaseExpiresAt },
    };
  }
  return { command: `/factory resume ${job.id}`, heldBy: null };
}
