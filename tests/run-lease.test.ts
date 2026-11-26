/**
 * The controller keeps its running child's job lease live (ticket 0177): a long foreground
 * subagent runs no `orch` command, so the controller's heartbeat renews the `orch-runner` lease
 * while the child is alive, never for another session's job and never after the child exits.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { ClaudeChild, LaunchInput } from '../src/integrations/claude-session.ts';
import {
  keepChildLease,
  LEASE_RENEW_EVERY_MS,
  type LeaseKeep,
  RUNNER_SESSION,
  startSession,
} from '../src/ops/run.ts';
import type { RunnerSession } from '../src/ops/runner-state.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob } from '../src/storage/jobs.ts';
import { type Job, jobs } from '../src/storage/schema.ts';
import { clone, DEAD_PID, finish, status, store, ticket } from './run-fixture.ts';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const setLease = (id: string, at: string) => {
  store.db.update(jobs).set({ leaseExpiresAt: at }).where(eq(jobs.id, id)).run();
};

/** A Claude child that runs `life` (the long build) and exits when it resolves. */
function longChild(life: (jobId: string) => Promise<void>) {
  let lived = false;
  return (input: LaunchInput): ClaudeChild => {
    const jobId = /job-[0-9a-f]{8}/.exec(input.prompt)?.[0] ?? '';
    const run = lived ? Promise.resolve() : life(jobId);
    lived = true;
    return {
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      done: run.then(() => ({ code: 0, signal: null, error: null })),
      kill: () => undefined,
    };
  };
}

/** Real waits, a heartbeat every 10 ms: the lease rules themselves are production's. */
const live = (launch: (input: LaunchInput) => ClaudeChild) =>
  ({ launch, pollMs: 5, beatMs: 10, githubBackoff: [0, 0, 0, 0, 0] }) as const;

describe('controller: the running child keeps its lease', () => {
  it('renews a lapsing orch-runner lease while the child runs, once per interval, with no event (AC1, AC2, AC6)', async () => {
    const id = ticket('Long build');
    const seen: Job[] = [];
    const counts: number[] = [];
    const launch = longChild(async (jobId) => {
      const look = () => {
        seen.push(getJob(store.db, jobId));
        counts.push(listEvents(store.db, jobId, 1000).length);
      };
      look(); // start
      await pause(150); // many beats with more than half the lease left
      look(); // quiet
      setLease(jobId, inSeconds(-60)); // one lease length later: lapsed
      for (
        let i = 0;
        i < 200 && (getJob(store.db, jobId).leaseExpiresAt ?? '') < inSeconds(600);
        i++
      ) {
        await pause(10);
      }
      look(); // renewed
      setLease(jobId, inSeconds(60)); // near expiry again, inside the throttle interval
      await pause(150);
      look(); // throttled
      finish(getJob(store.db, jobId));
    });
    const summary = await startSession(store, { mode: 'ticket', ticket: id }, live(launch));

    const [start, quiet, renewed, throttled] = seen;
    if (!start || !quiet || !renewed || !throttled) throw new Error('the child never ran');
    expect(quiet.leaseExpiresAt).toBe(start.leaseExpiresAt);
    expect(quiet.revision).toBe(start.revision);
    expect((renewed.leaseExpiresAt ?? '') > inSeconds(20 * 60)).toBe(true);
    expect(renewed.ownerSession).toBe(RUNNER_SESSION);
    expect(renewed.ownerToken).toBe(start.ownerToken);
    expect(renewed.revision).toBe(start.revision + 1);
    expect(throttled.revision).toBe(renewed.revision);
    expect((throttled.leaseExpiresAt ?? '') < inSeconds(120)).toBe(true);
    expect(new Set(counts).size).toBe(1);
    expect(summary.completed).toBe(1);
    expect(status(id)).toBe('done');
  });

  it('never renews or takes over a job another session holds (AC4)', async () => {
    const id = ticket('Taken by another');
    const seen: Job[] = [];
    const launch = longChild(async (jobId) => {
      claimJob(store, jobId, { session: 'other', force: true });
      setLease(jobId, inSeconds(60));
      seen.push(getJob(store.db, jobId));
      await pause(150);
      seen.push(getJob(store.db, jobId));
    });
    await startSession(store, { mode: 'ticket', ticket: id }, live(launch));
    const [held, after] = seen;
    expect(after).toEqual(held);
    expect(held?.ownerSession).toBe('other');
  });
});

describe('keepChildLease: the heartbeat step', () => {
  const T = Date.now();
  const runnerJob = () => {
    const job = createJob(store, {
      title: 'T',
      description: 'Test request',
      repo: 'github.com/acme/alpha',
      repoPath: clone,
      baseBranch: 'main',
    });
    claimJob(store, job.id, { session: RUNNER_SESSION });
    setLease(job.id, new Date(T + 60_000).toISOString());
    return getJob(store.db, job.id);
  };
  const session = (jobId: string, child: RunnerSession['child']) =>
    ({ jobId, child }) as RunnerSession;
  const fresh = (): LeaseKeep => ({ jobId: null, at: 0, refused: null });

  it('renews at most once per interval (AC2)', () => {
    const job = runnerJob();
    const s = session(job.id, { pid: 1, startedAt: 'x' });
    const keep = fresh();
    keepChildLease(store, s, keep, () => undefined, T);
    const once = getJob(store.db, job.id);
    expect(once.revision).toBe(job.revision + 1);
    setLease(job.id, new Date(T + 60_000).toISOString());
    keepChildLease(store, s, keep, () => undefined, T + LEASE_RENEW_EVERY_MS - 1);
    expect(getJob(store.db, job.id).revision).toBe(once.revision);
    keepChildLease(store, s, keep, () => undefined, T + LEASE_RENEW_EVERY_MS);
    expect(getJob(store.db, job.id).revision).toBe(once.revision + 1);
  });

  it('does nothing once the child has exited (AC3)', () => {
    const job = runnerJob();
    keepChildLease(store, session(job.id, null), fresh(), () => undefined, T);
    expect(getJob(store.db, job.id)).toEqual(job);
  });

  it('a refusal for ownership is logged once and not retried for that child (AC5)', () => {
    const job = runnerJob();
    const s = session(job.id, { pid: 1, startedAt: 'x' });
    const keep = fresh();
    const lines: string[] = [];
    // A row whose token no renewal can match: `renewLease` refuses it with exit 4.
    store.db.update(jobs).set({ ownerToken: null }).where(eq(jobs.id, job.id)).run();
    const refused = getJob(store.db, job.id);
    const log = (l: string) => lines.push(l);
    keepChildLease(store, s, keep, log, T);
    keepChildLease(store, s, keep, log, T + 10 * LEASE_RENEW_EVERY_MS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/lease not renewed: Job is not claimed/);
    expect(getJob(store.db, job.id)).toEqual(refused);
    expect(keep.refused).toBe(s.child);
  });
});
