/** The recovery worker's pure rules: one class per job, the failure streak, and the pass delay. */
import { describe, expect, it } from 'vitest';

import {
  classifyJob,
  failureStreak,
  RECOVERY_MAX_FAILURES,
  RECOVERY_SESSION,
} from '../src/core/recovery.ts';
import { nextDelay, type RecoveryPass } from '../src/ops/recover.ts';
import type { Event, Job } from '../src/storage/schema.ts';

const NOW = '2026-11-16T12:00:00.000Z';
const LATER = '2026-11-16T12:30:00.000Z';
const EARLIER = '2026-11-16T11:00:00.000Z';
const PR = 'https://github.com/acme/alpha/pull/1';

type Row = Parameters<typeof classifyJob>[0];
const row = (over: Partial<Job> = {}): Row => ({
  stage: 'ci',
  status: 'pending',
  ownerSession: null,
  leaseExpiresAt: null,
  prUrl: PR,
  ciHead: 'abc',
  archivedAt: null,
  supersededBy: null,
  ...over,
});

let nextId = 1;
const ev = (
  type: string,
  payload: Record<string, unknown> = {},
  actor = RECOVERY_SESSION,
): Event => ({
  id: nextId++,
  jobId: 'job-1',
  type,
  payload,
  actor,
  createdAt: NOW,
});
const failed = (head = 'abc') => ev('recovery.failed', { head, reason: 'gh failed' });
const attempted = (head = 'abc') => ev('recovery.attempted', { head });

const cls = (r: Row, events: Event[] = []) => classifyJob(r, events, NOW).class;

describe('classifyJob', () => {
  it('active: another session holds a live lease, even on a ci job', () => {
    expect(cls(row({ status: 'running', ownerSession: 's1', leaseExpiresAt: LATER }))).toBe(
      'active',
    );
    expect(cls(row({ stage: 'build', ownerSession: 's1', leaseExpiresAt: LATER }))).toBe('active');
  });

  it('human: needs-human, blocked, failed, cancelled, completed, archived, superseded', () => {
    expect(cls(row({ stage: 'needs-human', status: 'blocked' }))).toBe('human');
    expect(cls(row({ status: 'blocked' }))).toBe('human');
    expect(cls(row({ status: 'failed' }))).toBe('human');
    expect(cls(row({ status: 'cancelled' }))).toBe('human');
    expect(cls(row({ stage: 'completed', status: 'completed' }))).toBe('human');
    expect(cls(row({ archivedAt: NOW }))).toBe('human');
    expect(cls(row({ supersededBy: 'job-2' }))).toBe('human');
    // Even with a live owner: a human decision comes first.
    expect(
      cls(
        row({ stage: 'needs-human', status: 'blocked', ownerSession: 's1', leaseExpiresAt: LATER }),
      ),
    ).toBe('human');
  });

  it('recoverable: ci with a PR and no live lease, pending, interrupted, or running', () => {
    expect(cls(row())).toBe('recoverable');
    expect(cls(row({ status: 'interrupted' }))).toBe('recoverable');
    expect(cls(row({ status: 'running', ownerSession: 's1', leaseExpiresAt: EARLIER }))).toBe(
      'recoverable',
    );
    // Released while running (the stranded case) is still continued.
    expect(cls(row({ status: 'running' }))).toBe('recoverable');
    // The worker's own lapsed or interrupted episode does not block it.
    expect(
      cls(row({ status: 'running', ownerSession: RECOVERY_SESSION, leaseExpiresAt: LATER })),
    ).toBe('recoverable');
  });

  it('needs-session: an agent stage, or ci without a PR, with no live owner', () => {
    expect(cls(row({ stage: 'build', status: 'pending' }))).toBe('needs-session');
    for (const stage of ['spec', 'review', 'approve', 'pr'] as const) {
      expect(
        cls(row({ stage, status: 'interrupted', ownerSession: 's1', leaseExpiresAt: EARLIER })),
      ).toBe('needs-session');
    }
    expect(cls(row({ prUrl: null }))).toBe('needs-session');
    expect(classifyJob(row({ stage: 'build' }), [], NOW).reason).toContain(
      'needs an agent session',
    );
  });

  it('exhausted: the retry budget for this head is spent', () => {
    const five = Array.from({ length: RECOVERY_MAX_FAILURES }, () => failed());
    expect(cls(row(), five)).toBe('exhausted');
    // Failures for an older head do not count against the new one.
    expect(cls(row({ ciHead: 'def' }), five)).toBe('recoverable');
  });
});

describe('failureStreak', () => {
  it('counts consecutive failures for the head and resets on a successful attempt', () => {
    expect(failureStreak([attempted(), failed(), attempted(), failed()], 'abc')).toBe(2);
    expect(failureStreak([failed(), failed(), attempted(), attempted(), failed()], 'abc')).toBe(1);
    expect(failureStreak([failed(), attempted()], 'abc')).toBe(0);
    expect(failureStreak([failed('old'), failed()], 'abc')).toBe(1);
  });

  it('a claim by another session starts the count again', () => {
    expect(failureStreak([failed(), failed(), ev('job.claimed', {}, 'human-1')], 'abc')).toBe(0);
    expect(failureStreak([failed(), ev('job.claimed'), failed()], 'abc')).toBe(2);
  });
});

describe('nextDelay', () => {
  const pass = (online: boolean, waits: (number | null)[] = []): RecoveryPass => ({
    at: NOW,
    online,
    probeError: online ? null : 'offline',
    nextSeconds: null,
    jobs: waits.map((w, i) => ({
      jobId: `job-${String(i)}`,
      title: 't',
      stage: 'ci',
      status: 'running',
      class: 'active',
      reason: '',
      action: 'none',
      detail: null,
      resume: null,
      waitSeconds: w,
    })),
  });

  it('backs off exponentially from 30 s to 10 min while offline', () => {
    let backoff: number | null = null;
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = nextDelay(pass(false), backoff);
      backoff = d.backoff;
      seen.push(d.seconds);
    }
    expect(seen).toEqual([30, 60, 120, 240, 480, 600, 600]);
    expect(nextDelay(pass(true), 600).backoff).toBeNull();
  });

  it('online: the smallest CI wait, never under 60 s', () => {
    expect(nextDelay(pass(true), null).seconds).toBe(60);
    expect(nextDelay(pass(true, [null, 300, 120]), null).seconds).toBe(120);
    expect(nextDelay(pass(true, [15]), null).seconds).toBe(60);
  });
});
