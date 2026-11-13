/**
 * Job ownership via leases. There is no daemon, so leases are renewed only by CLI calls: every
 * successful mutation by the owner extends the lease, and `claim` by the same session renews it
 * explicitly. When a session dies, its lease simply expires and another session may claim.
 */
import { randomBytes } from 'node:crypto';

import { OwnershipError } from './errors.ts';
import type { Job } from '../storage/schema.ts';

export const DEFAULT_LEASE_MINUTES = 30;

type Lease = Pick<Job, 'ownerSession' | 'ownerToken' | 'leaseExpiresAt' | 'status'>;

export function leaseExpired(job: Lease, nowIso: string): boolean {
  return job.leaseExpiresAt === null || job.leaseExpiresAt < nowIso;
}

export function leaseUntil(nowIso: string, minutes: number): string {
  return new Date(Date.parse(nowIso) + minutes * 60_000).toISOString();
}

export type ClaimKind = 'new' | 'renew' | 'reclaim';

/** Decide whether `session` may take the job. Throws when another live owner holds it. */
export function decideClaim(job: Lease, session: string, nowIso: string, force = false): ClaimKind {
  if (job.ownerSession === null) return 'new';
  if (job.ownerSession === session) return 'renew';
  if (force || leaseExpired(job, nowIso)) return 'reclaim';
  throw new OwnershipError(
    `Job is owned by session ${job.ownerSession} until ${String(job.leaseExpiresAt)}. ` +
      'Wait for the lease to expire or claim with --force.',
  );
}

/** Mutations require the current owner token. Expired-but-unreclaimed owners stay valid. */
export function assertOwner(job: Lease, token: string | undefined): void {
  if (job.ownerToken === null) {
    throw new OwnershipError(
      'Job is not claimed. Run `orch job claim <id> --session <name>` first.',
    );
  }
  if (!token) throw new OwnershipError('Missing --token (or ORCH_TOKEN) for this job.');
  if (token !== job.ownerToken) {
    throw new OwnershipError(
      `Stale or invalid token: job is now owned by session ${String(job.ownerSession)}.`,
    );
  }
}

export function newToken(): string {
  return randomBytes(16).toString('hex');
}
