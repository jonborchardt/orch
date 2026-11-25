/**
 * A session a live factory controller launched releases a pending ci job at its first
 * observation (`controllerTakesCi`): the controller polls CI itself. Any other session keeps
 * the CI_MAX_SESSION_POLLS threshold (tests/ci-repair.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { planJob } from '../src/ops/factory.ts';
import { acquireRunnerLock, type RunnerSession, writeSession } from '../src/ops/runner-state.ts';
import { checks, clone, reconcile, run, store } from './ci-fixture.ts';
import { head, start, toCi } from './drive.ts';

describe('ci stage: a controller-launched session', () => {
  it('releases at the first pending observation only while a live controller runs its child', () => {
    const c = start(store, clone);
    toCi(store, c);
    checks(head(c.wt), [run('test', null, 'queued')]);
    expect(reconcile(c).action).toBe('wait');
    const release = () => planJob(store, c.id).ci.release;
    const at = new Date().toISOString();
    const session: RunnerSession = {
      pid: process.pid,
      startedAt: at,
      beatAt: at,
      mode: 'ticket',
      repo: null,
      ticket: null,
      ticketId: null,
      jobId: c.id,
      child: { pid: process.pid, startedAt: at },
      results: [],
      skipped: [],
      finished: null,
    };

    // No session file, with and without a live lock.
    expect(release()).toBe(false);
    const unlock = acquireRunnerLock(store.paths);
    expect(release()).toBe(false);

    writeSession(store.paths, session);
    const plan = planJob(store, c.id);
    expect(plan.ci).toMatchObject({ sessionPolls: 1, release: true });
    expect(plan.reason).toContain('controller that launched this session polls CI');
    expect(plan.commands).toEqual([`orch job release ${c.id} --token <token>`]);

    for (const other of [
      { finished: { at, reason: 'done' } },
      { jobId: 'job-00000000' },
      { child: null },
    ]) {
      writeSession(store.paths, { ...session, ...other });
      expect(release()).toBe(false);
    }

    // The session names this job, but no controller holds the lock any more.
    writeSession(store.paths, session);
    unlock();
    expect(release()).toBe(false);
  });
});
