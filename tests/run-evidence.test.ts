/**
 * What the factory controller leaves on a job's own event log (`runner.session`,
 * `runner.stopped`), the lease it gives back when a ticket stops, a human decision continuing the
 * same job, and a resume in the middle of a re-land. The Claude child is the stand-in of
 * tests/run-fixture.ts; tests/run-repair.test.ts drives a real job through a CI repair.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REPORTED_EVENTS } from '../src/core/mail-report.ts';
import type { LaunchInput } from '../src/integrations/claude-session.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { resumeSession, RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { readSession } from '../src/ops/runner-state.ts';
import { sessionLog } from '../src/server/api.ts';
import { claimJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import {
  type Act,
  clone,
  DEAD_PID,
  done,
  editPr,
  eventsOf,
  finish,
  hanging,
  idle,
  jobsOf,
  launcher,
  merges,
  one,
  OTHER,
  queue,
  quick,
  status,
  store,
  ticket,
} from './run-fixture.ts';

// Lets one test make every event the controller records fail, as a full disk would.
const broken = vi.hoisted(() => ({ on: false }));
vi.mock('../src/storage/jobs.ts', async (original) => {
  const real = await original<typeof import('../src/storage/jobs.ts')>();
  return {
    ...real,
    recordEvent: (...args: Parameters<typeof real.recordEvent>) => {
      if (broken.on) throw new Error('disk full');
      return real.recordEvent(...args);
    },
  };
});
beforeEach(() => {
  broken.on = false;
});

const sessions = (jobId: string) => eventsOf(jobId, 'runner.session');
const stops = (jobId: string) => eventsOf(jobId, 'runner.stopped');
const key = (id: number) => String(id).padStart(4, '0');

/** A session that escalates and exits still holding the job, as a child that forgot to release. */
const escalate: Act = (job) => {
  const { token } = claimJob(store, job.id, { session: RUNNER_SESSION });
  transitionJob(store, job.id, 'start', { token });
  transitionJob(store, job.id, 'escalate', { token, reason: 'two designs are possible' });
};

describe('runner.session: one Claude child, from start to exit', () => {
  it('records exit, duration, and whether the job moved; a clean exit is not a success', async () => {
    const id = ticket('Stuck');

    const s = await one(launcher(idle), id);

    const job = jobsOf(id)[0];
    const recorded = sessions(job?.id ?? '');
    expect(recorded).toHaveLength(2);
    for (const e of recorded) {
      expect(e.actor).toBe(RUNNER_SESSION);
      expect(e.payload).toMatchObject({
        outcome: 'exited',
        exitCode: 0,
        signal: null,
        error: null,
        pid: DEAD_PID,
        moved: false,
        stage: 'spec',
      });
      expect(typeof e.payload['seconds']).toBe('number');
    }
    // Exit code 0 twice, and the ticket is blocked all the same.
    expect(s.tickets[0]?.outcome).toBe('blocked');
    expect(stops(job?.id ?? '').map((e) => e.payload)).toEqual([
      {
        outcome: 'blocked',
        code: 'no-progress',
        reason: s.tickets[0]?.reason,
        stage: 'spec',
        status: job?.status,
        next: s.tickets[0]?.next,
      },
    ]);
    expect(job?.ownerSession).toBeNull();
  });

  it('a later controller session keeps the record, and a completed ticket adds no stop', async () => {
    const id = ticket('Second try works');
    await one(launcher(idle), id);
    const job = jobsOf(id)[0];
    const jobId = job?.id ?? '';
    const before = [...sessions(jobId), ...stops(jobId)].map((e) => e.id);

    // The new session replaces runner.json; the job's events are untouched.
    const s = await one(launcher(done), id);

    expect(readSession(store.paths)?.results.map((r) => r.outcome)).toEqual(['done']);
    expect(s.tickets[0]).toMatchObject({ outcome: 'done', jobId });
    expect([...sessions(jobId), ...stops(jobId)].map((e) => e.id)).toEqual(
      expect.arrayContaining(before),
    );
    expect(sessions(jobId).at(-1)?.payload).toMatchObject({
      outcome: 'exited',
      moved: true,
      stage: 'completed',
    });
    expect(stops(jobId)).toHaveLength(1);
    expect(status(id)).toBe('done');
    expect(getJob(store.db, jobId).ownerSession).toBeNull();
  });

  it('ties each child to the job by its --session-id before it starts, for the Session tab', async () => {
    const id = ticket('Watched');
    const seen: (string | undefined)[] = [];
    // At launch the job already names the uuid the child is given.
    const l = launcher((job, input) => {
      const attached = eventsOf(job.id, 'session.attached').at(-1)?.payload;
      expect(attached).toMatchObject({ provider: 'claude-code', ref: input.sessionId });
      expect(attached?.['cwd']).toBe(input.cwd);
      seen.push(input.sessionId);
    });

    await one(l, id);

    const jobId = jobsOf(id)[0]?.id ?? '';
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(sessions(jobId).map((e) => e.payload['sessionId'])).toEqual(seen);
    // The dashboard's existing read model resolves the newest one, unchanged.
    expect(sessionLog(store, jobId).ref).toBe(seen[1]);
  });

  it('keeps the stderr tail and result summary of a child that failed', async () => {
    const id = ticket('Crashed');
    const launch = (input: LaunchInput) => {
      input.onLine?.('Bash: npm test');
      return {
        pid: DEAD_PID,
        startedAt: new Date().toISOString(),
        done: Promise.resolve({
          code: 1,
          signal: null,
          error: null,
          stderrTail: 'API Error: 529 overloaded\n',
          result: { subtype: 'error_during_execution', isError: true, result: null, numTurns: 3 },
        }),
        kill: () => undefined,
      };
    };
    const log: string[] = [];

    await startSession(
      store,
      { mode: 'ticket', ticket: id },
      { launch, log: (line) => log.push(line), ...quick },
    );

    const jobId = jobsOf(id)[0]?.id ?? '';
    expect(log).toContain('  claude: Bash: npm test');
    expect(sessions(jobId)[0]?.payload).toMatchObject({
      outcome: 'exited',
      exitCode: 1,
      stderrTail: 'API Error: 529 overloaded\n',
      result: { subtype: 'error_during_execution', isError: true, numTurns: 3 },
    });
  });

  it('a requested stop records the ended session and no failure', async () => {
    const id = ticket('Stopped');
    const h = hanging();

    const s = await queue(h);

    const job = jobsOf(id)[0];
    expect(h.killed).toBe(1);
    expect(s).toMatchObject({ stopped: true, blocked: 0 });
    expect(sessions(job?.id ?? '').map((e) => e.payload)).toMatchObject([
      { outcome: 'stopped', exitCode: null, signal: 'SIGTERM', moved: false },
    ]);
    expect(stops(job?.id ?? '')).toHaveLength(0);
    expect(job).toMatchObject({ stage: 'spec', ownerSession: null });
    expect(readSession(store.paths)).toMatchObject({ finished: null, jobId: job?.id });
  });
});

describe('runner.stopped: the controller gave the ticket up', () => {
  it('is among the events a status mail reports', () => {
    expect(REPORTED_EVENTS).toContain('runner.stopped');
  });

  const cases: [string, string, string, Record<string, unknown>][] = [
    [
      'a merge at a head nobody verified',
      'unverified-merge',
      'blocked',
      { state: 'MERGED', headRefOid: OTHER, mergeCommit: { oid: 'c'.repeat(40) } },
    ],
    ['a PR head that changed after CI', 'head-changed', 'needs-human', { headRefOid: OTHER }],
    ['a PR still in draft', 'pr-draft', 'needs-human', { isDraft: true }],
    ['mergeability GitHub never decided', 'merge-no-answer', 'blocked', { mergeable: 'UNKNOWN' }],
  ];
  it.each(cases)('%s is recorded on the completed job as %s', async (_name, code, outcome, pr) => {
    const id = ticket('Cannot merge');
    const job = dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job;
    editPr(finish(job), pr);

    const s = await one(launcher(idle), id);

    expect(s.tickets[0]?.outcome).toBe(outcome);
    expect(stops(job.id).map((e) => e.payload)).toMatchObject([
      { outcome, code, reason: s.tickets[0]?.reason, stage: 'completed' },
    ]);
    // A controller-level stop: the job is what it was, and nobody holds it.
    expect(getJob(store.db, job.id)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ownerSession: null,
    });
    expect(sessions(job.id)).toHaveLength(0);
    expect(status(id)).toBe('in-progress');

    // The same refusal again is the same stop: nothing is added.
    await one(launcher(idle), id);
    expect(stops(job.id)).toHaveLength(1);
  });

  it('a Claude that cannot be started is recorded as claude-failed, once, and the job released', async () => {
    const id = ticket('No claude');
    let launches = 0;
    const launch = () => {
      launches += 1;
      return {
        pid: 0,
        startedAt: new Date().toISOString(),
        done: Promise.resolve({ code: null, signal: null, error: 'spawn claude ENOENT' }),
        kill: () => undefined,
      };
    };

    const s = await one({ launch, calls: [] }, id);

    const job = jobsOf(id)[0];
    const jobId = job?.id ?? '';
    // Not retried: a second launch would fail the same way.
    expect(launches).toBe(1);
    expect(s.tickets[0]).toMatchObject({ outcome: 'blocked', jobId });
    expect(sessions(jobId).map((e) => e.payload)).toMatchObject([
      { outcome: 'failed', exitCode: null, error: 'spawn claude ENOENT', pid: null, moved: false },
    ]);
    expect(stops(jobId).map((e) => e.payload)).toMatchObject([
      {
        outcome: 'blocked',
        code: 'claude-failed',
        reason: s.tickets[0]?.reason,
        stage: 'spec',
      },
    ]);
    expect(job).toMatchObject({ stage: 'spec', ownerSession: null, ownerToken: null });
    expect(status(id)).toBe('in-progress');
    expect(merges()).toHaveLength(0);
  });

  it('an event that cannot be written still releases the job and leaves the ticket blocked', async () => {
    const id = ticket('Disk full');
    const log: string[] = [];
    broken.on = true;

    // The session escalates and exits holding the job; neither event about it can be recorded.
    const s = await startSession(
      store,
      { mode: 'ticket', ticket: id },
      { launch: launcher(escalate).launch, log: (line) => log.push(line), ...quick },
    );

    const job = jobsOf(id)[0];
    const jobId = job?.id ?? '';
    expect(s).toMatchObject({ completed: 0, blocked: 1 });
    expect(s.tickets[0]).toMatchObject({ outcome: 'needs-human', jobId });
    expect([...stops(jobId), ...sessions(jobId)]).toHaveLength(0);
    expect(job).toMatchObject({ stage: 'needs-human', ownerSession: null, ownerToken: null });
    expect(
      log.filter((l) => l.includes('could not be recorded and released: disk full')),
    ).toHaveLength(2);
    expect(status(id)).toBe('in-progress');
    expect(merges()).toHaveLength(0);
  });

  it('writes nothing to a job another live session holds, and leaves its lease', async () => {
    const id = ticket('Held');
    const job = dispatchJob(store, { ticket: id, session: 'human', cwd: clone }).job;
    claimJob(store, job.id, { session: 'human' });
    const lease = getJob(store.db, job.id).leaseExpiresAt;

    const s = await one(launcher(done), id);

    expect(s.tickets[0]?.outcome).toBe('blocked');
    expect(getJob(store.db, job.id)).toMatchObject({
      ownerSession: 'human',
      leaseExpiresAt: lease,
    });
    expect([...stops(job.id), ...sessions(job.id)]).toHaveLength(0);
  });

  it('does not take back a job a person claimed while the session was ending', async () => {
    const id = ticket('Taken over');
    const l = launcher((job, input) => {
      escalate(job, input);
      claimJob(store, job.id, { session: 'human', force: true });
    });

    const s = await one(l, id);

    const job = jobsOf(id)[0];
    expect(s.tickets[0]?.outcome).toBe('needs-human');
    expect(job).toMatchObject({ stage: 'needs-human', ownerSession: 'human' });
    expect([...stops(job?.id ?? ''), ...sessions(job?.id ?? '')]).toHaveLength(0);
  });
});

describe('a job that needs a person', () => {
  it('is released with its reason on record, decided on the dashboard, and continued by orch do', async () => {
    const id = ticket('Needs a decision');
    const l = launcher(escalate, done);

    const s = await one(l, id);

    const jobId = jobsOf(id)[0]?.id ?? '';
    expect(s.tickets[0]).toMatchObject({ outcome: 'needs-human', jobId });
    expect(stops(jobId).map((e) => e.payload)).toMatchObject([
      { outcome: 'needs-human', code: 'needs-human', stage: 'needs-human', status: 'blocked' },
    ]);
    expect(stops(jobId)[0]?.payload['reason']).toContain('two designs are possible');
    expect(stops(jobId)[0]?.payload['next']).toContain(`orch do ${key(id)}`);
    // Escalated from spec: the hint names the steps that work (todo 0107), in both places.
    for (const next of [s.tickets[0]?.next, stops(jobId)[0]?.payload['next']]) {
      for (const part of [
        'spec.md',
        'Resume at spec',
        '--to spec --release',
        `orch do ${key(id)}`,
      ]) {
        expect(next).toContain(part);
      }
      expect(next).not.toContain('orch job release');
    }
    // Escalated, not finished; and the runner's lease is gone although the session kept it.
    expect(getJob(store.db, jobId)).toMatchObject({
      stage: 'needs-human',
      status: 'blocked',
      returnStage: 'spec',
      ticketId: id,
      ownerSession: null,
      ownerToken: null,
    });
    expect(status(id)).toBe('in-progress');
    expect(merges()).toHaveLength(0);

    // Asking again before anyone decided starts nothing and records nothing new.
    await one(l, id);
    expect(l.calls).toHaveLength(1);
    expect(stops(jobId)).toHaveLength(1);

    // The person decides with the dashboard's own action; no lease is in the way.
    const decided = dashboardAction(store, jobId, { action: 'approve', reason: 'take the first' });
    expect(decided.job).toMatchObject({ stage: 'spec', status: 'pending', ownerSession: null });

    const again = await one(l, id);

    expect(l.calls.map((c) => c.jobId)).toEqual([jobId, jobId]);
    expect(jobsOf(id)).toHaveLength(1);
    expect(again.tickets[0]).toMatchObject({ outcome: 'done', jobId });
    expect(status(id)).toBe('done');
    // The blocker and the decision stay on the job's record.
    expect(eventsOf(jobId, 'job.blocked')[0]?.payload['reason']).toBe('two designs are possible');
    expect(eventsOf(jobId, 'job.resumed')[0]?.actor).toBe('dashboard');
    expect(stops(jobId)).toHaveLength(1);
  });
});

describe('resume in the middle of a re-land', () => {
  const conflicting: Act = (job) => {
    finish(job, { mergeable: 'CONFLICTING' });
  };

  /** The first job conflicts at merge; the controller is stopped while the re-land job runs. */
  async function interruptedReland(): Promise<{ id: number; first: string; second: string }> {
    const id = ticket('Conflicts once');
    const h = hanging(conflicting);
    const s = await one(h, id);
    const [first, second] = jobsOf(id).map((j) => j.id);
    expect(s.stopped).toBe(true);
    expect(h.calls.map((c) => c.jobId)).toEqual([first, second]);
    expect(readSession(store.paths)).toMatchObject({ finished: null, ticketId: id, jobId: second });
    expect(getJob(store.db, first ?? '').supersededBy).toBe(second);
    expect(getJob(store.db, second ?? '')).toMatchObject({ ticketId: id, ownerSession: null });
    return { id, first: first ?? '', second: second ?? '' };
  }

  it('continues the re-land job, merges only it, and creates no third job', async () => {
    const { id, first, second } = await interruptedReland();
    const l = launcher(done);

    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(l.calls.map((c) => c.jobId)).toEqual([second]);
    expect(jobsOf(id).map((j) => j.id)).toEqual([first, second]);
    expect(r.tickets[0]).toMatchObject({ outcome: 'done', jobId: second });
    expect(merges()).toHaveLength(1);
    expect(merges()[0]).toContain(getJob(store.db, second).prUrl);
    expect(getJob(store.db, first).prState).not.toBe('merged');
    expect(getJob(store.db, second).prState).toBe('merged');
    expect(status(id)).toBe('done');
    expect(sessions(second).map((e) => e.payload['outcome'])).toEqual(['stopped', 'exited']);
  });

  it('a second conflict after the resume is still the end: recorded, and no third job', async () => {
    const { id, first, second } = await interruptedReland();
    const l = launcher(conflicting);

    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(l.calls.map((c) => c.jobId)).toEqual([second]);
    expect(jobsOf(id).map((j) => j.id)).toEqual([first, second]);
    expect(r.tickets[0]).toMatchObject({ outcome: 'needs-human', jobId: second });
    expect(stops(second).map((e) => e.payload)).toMatchObject([
      { outcome: 'needs-human', code: 'second-conflict', stage: 'completed' },
    ]);
    expect(stops(first)).toHaveLength(0);
    expect(merges()).toHaveLength(0);
    expect(status(id)).toBe('in-progress');
  });
});
