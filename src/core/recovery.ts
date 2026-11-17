/**
 * Which jobs the opt-in recovery worker may continue on its own (decision
 * 2026-11-16-opt-in-recovery-worker). Pure: the row, its events, and the time decide.
 *
 * Recoverable means the next step is an operation orch runs itself, needs no agent, and is safe to
 * repeat: today only the ci stage, where `orch gh ci` re-reads GitHub. Agent stages need a session,
 * which the worker never launches.
 */
import { leaseExpired } from './ownership.ts';
import type { Event, Job } from '../storage/schema.ts';

/** The worker's owner identity on every claim it makes. */
export const RECOVERY_SESSION = 'orch-recovery';
/** Consecutive failed attempts for one head before the job is escalated to a human. */
export const RECOVERY_MAX_FAILURES = 5;
export const RECOVERY_EXHAUSTED_REASON = 'recovery retries exhausted';

export type RecoveryClass = 'active' | 'human' | 'recoverable' | 'needs-session' | 'exhausted';

export interface Classified {
  class: RecoveryClass;
  reason: string;
}

type JobRow = Pick<
  Job,
  | 'stage'
  | 'status'
  | 'ownerSession'
  | 'leaseExpiresAt'
  | 'prUrl'
  | 'ciHead'
  | 'archivedAt'
  | 'supersededBy'
>;

/**
 * Consecutive `recovery.failed` events for `head` at the end of the log. A `recovery.attempted`
 * without a failure after it was a successful attempt, and a claim by any other session (a human
 * or a session resuming the job) starts the count again.
 */
export function failureStreak(events: readonly Event[], head: string | null): number {
  let streak = 0;
  let open = false; // an attempt with no failure recorded after it yet
  for (const e of events) {
    if (e.type === 'recovery.attempted') {
      if (open) streak = 0;
      open = true;
    } else if (e.type === 'recovery.failed') {
      open = false;
      streak = e.payload['head'] === head ? streak + 1 : 0;
    } else if (e.type === 'job.claimed' && e.actor !== RECOVERY_SESSION) {
      streak = 0;
      open = false;
    }
  }
  return open ? 0 : streak;
}

/** Sort one job into exactly one class. */
export function classifyJob(job: JobRow, events: readonly Event[], nowIso: string): Classified {
  if (job.archivedAt !== null) return { class: 'human', reason: 'archived' };
  if (job.supersededBy !== null)
    return { class: 'human', reason: `superseded by ${job.supersededBy}` };
  if (job.stage === 'needs-human' || job.stage === 'completed') {
    return { class: 'human', reason: `stage is ${job.stage}` };
  }
  if (['blocked', 'failed', 'cancelled', 'completed'].includes(job.status)) {
    return { class: 'human', reason: `status is ${job.status}` };
  }
  if (
    job.ownerSession !== null &&
    job.ownerSession !== RECOVERY_SESSION &&
    !leaseExpired(job, nowIso)
  ) {
    return {
      class: 'active',
      reason: `owned by ${job.ownerSession} until ${String(job.leaseExpiresAt)}`,
    };
  }
  const streak = failureStreak(events, job.ciHead);
  if (streak >= RECOVERY_MAX_FAILURES) {
    return {
      class: 'exhausted',
      reason: `${RECOVERY_EXHAUSTED_REASON}: ${String(streak)} failed attempts for this head`,
    };
  }
  const owner = job.ownerSession === null ? 'no owner' : `the lease of ${job.ownerSession} lapsed`;
  if (job.stage === 'ci' && job.prUrl !== null) {
    return { class: 'recoverable', reason: `ci stage, ${job.status}, ${owner}` };
  }
  return {
    class: 'needs-session',
    reason:
      job.stage === 'ci'
        ? `ci stage without a recorded PR, ${owner}: a session must deliver it`
        : `${job.stage} stage needs an agent session, ${owner}`,
  };
}
