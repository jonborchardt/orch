/**
 * A short ownership episode on a job for a caller that is not its worker: the dashboard, a
 * tokenless CLI command, `orch job merge`.
 */
import { OwnershipError, ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import { now } from '../core/workflow.ts';
import type { Store } from '../storage/client.ts';
import { claimJob, getJob, releaseJob } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';

/**
 * Who is asking for a short episode. `dashboard` is the human UI (and `orch job supersede`): a
 * live lease is a validation refusal, and a job waiting in needs-human is exempt because its
 * session is idle. `session` is a CLI caller that is itself a session: any live lease held by
 * another session is an ownership refusal (exit 4) unless the caller forces the takeover.
 */
export type LeaseMode = 'dashboard' | 'session';

/**
 * Claim the job as `session` for `leaseMinutes`, run `fn` with the token, release. A live lease
 * held by another session is respected unless the caller forces the takeover or, in `dashboard`
 * mode, the job is waiting in needs-human.
 */
export function withLease<T>(
  store: Store,
  before: Job,
  session: string,
  force: boolean | undefined,
  fn: (token: string) => T,
  mode: LeaseMode = 'dashboard',
  leaseMinutes = 1,
): T {
  const waiting = mode === 'dashboard' && before.stage === 'needs-human';
  const liveOwner =
    before.ownerSession !== null && before.ownerSession !== session && !leaseExpired(before, now());
  if (liveOwner && !waiting && !force) {
    const held =
      `Session ${String(before.ownerSession)} holds a live lease on this job` +
      (before.status === 'running' ? ' and reports it running' : '');
    if (mode === 'session') {
      throw new OwnershipError(
        `${held}. Use that session, wait for the lease to lapse, or pass --force to take it over.`,
      );
    }
    throw new ValidationError(
      `${held}. Use that session, wait for the lease to lapse, or confirm a forced takeover.`,
    );
  }
  const { token } = claimJob(store, before.id, {
    session,
    force: force ?? (liveOwner && waiting),
    leaseMinutes,
  });
  try {
    return fn(token);
  } finally {
    // Give the job up so a real session can resume it; the caller is not a worker. A cancel or
    // accepted delivery already released it in the write that finished it.
    if (getJob(store.db, before.id).ownerToken === token) releaseJob(store, before.id, { token });
  }
}
