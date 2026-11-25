/**
 * The foreground factory controller (src/ops/run.ts): ticket selection, dispatch, picking up
 * existing jobs, merge outcomes, the re-land, stop requests, interruption, and resume. The Claude
 * child is replaced by a function that puts the job in the state a session would leave it in
 * (tests/claude-session.test.ts starts real processes; tests/run-ci.test.ts drives a real job to
 * the ci stage). GitHub is the stateful shim; nothing reaches the network.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatSummary, summaryExitCode } from '../src/cli/run.ts';
import { ticketKey } from '../src/core/tickets.ts';
import { runnerPaths } from '../src/core/paths.ts';
import { cancelJob } from '../src/ops/actions.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { setMergeAuthorization } from '../src/ops/merge.ts';
import {
  MAX_IDLE_LAUNCHES,
  resumeSession,
  RUNNER_SESSION,
  runnerStatus,
  startSession,
  stopSession,
} from '../src/ops/run.ts';
import {
  acquireRunnerLock,
  controllerPid,
  readSession,
  requestStop,
  type RunnerSession,
  stopRequests,
  writeSession,
} from '../src/ops/runner-state.ts';
import { addTicket, ticketAction } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import {
  beta,
  clone,
  DEAD_PID,
  done,
  editPr,
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

// Lets one test create a competing job in the instant before the controller's own dispatch.
const race = vi.hoisted(() => ({ before: undefined as (() => void) | undefined }));
vi.mock('../src/ops/dispatch.ts', async (original) => {
  const real = await original<typeof import('../src/ops/dispatch.ts')>();
  return {
    ...real,
    dispatchJob: (...args: Parameters<typeof real.dispatchJob>) => {
      const before = race.before;
      race.before = undefined;
      before?.();
      return real.dispatchJob(...args);
    },
  };
});
beforeEach(() => {
  race.before = undefined;
});

/** What a Claude session leaves when the job needs a decision from a person. */
const escalate = (job: Job): void => {
  const { token } = claimJob(store, job.id, { session: RUNNER_SESSION });
  transitionJob(store, job.id, 'start', { token });
  transitionJob(store, job.id, 'escalate', { token, reason: 'two designs are possible' });
};

describe('orch start: the queue', () => {
  it('runs ready tickets best first, merges each verified PR, and ends when none is left', async () => {
    const low = ticket('Low', { priority: 'P3' });
    const high = ticket('High', { priority: 'P1' });
    const l = launcher(done);

    const s = await queue(l);

    expect(l.calls.map((c) => getJob(store.db, c.jobId).ticketId)).toEqual([high, low]);
    expect(s).toMatchObject({ attempted: 2, completed: 2, blocked: 0, stopped: false });
    expect(s.reason).toBe('no ready ticket is left');
    expect([status(high), status(low)]).toEqual(['done', 'done']);
    expect(merges()).toHaveLength(2);
    // The child ran in the job's own worktree under the controller's session, without a token.
    const first = l.calls[0];
    // The verified merge then removed that worktree (ticket 0142).
    const removed = listEvents(store.db, first?.jobId ?? '', 1000).find(
      (e) => e.type === 'worktree.removed',
    );
    expect(first?.cwd).toBe(removed?.payload['path']);
    expect(getJob(store.db, first?.jobId ?? '').worktreePath).toBeNull();
    expect(first?.cwd).not.toBe(clone);
    expect(first?.env['ORCH_SESSION']).toBe(RUNNER_SESSION);
    expect(first?.env['ORCH_TOKEN']).toBeUndefined();
    expect(first?.prompt.startsWith(`/factory ${first.jobId}`)).toBe(true);
    // Nothing is left running or holding the controller.
    expect(controllerPid(store.paths)).toBeNull();
    expect(readSession(store.paths)?.finished?.reason).toBe(s.reason);
    expect(runnerStatus(store)).toMatchObject({ state: 'idle', last: { completed: 2 } });
  });

  it('start repo takes only that repository; a ticket runs in its own repository wherever orch stands', async () => {
    setMergeAuthorization(store, beta.clone, true);
    const alpha = ticket('In alpha', { priority: 'P1' });
    const other = addTicket(store, { title: 'In beta', repo: beta.clone, priority: 'P3' }).id;
    const l = launcher(idle);

    const s = await queue(l, beta.clone);

    expect(s.tickets.map((t) => t.ticketId)).toEqual([other]);
    const job = getJob(store.db, l.calls[0]?.jobId ?? '');
    expect(job).toMatchObject({ ticketId: other, repo: 'github.com/acme/beta' });
    expect(l.calls[0]?.cwd).toBe(job.worktreePath);
    expect(jobsOf(alpha)).toHaveLength(0);
    expect(status(alpha)).toBe('open');
  });

  it('passes over a ticket that needs a person and goes on to the next ready ticket', async () => {
    const first = ticket('First', { priority: 'P1' });
    const second = ticket('Second', { priority: 'P2' });
    let next = '';
    const l = launcher((job) => {
      escalate(job);
      next = runnerStatus(store).next;
    }, done);

    const s = await queue(l);

    expect(next).toBe('Report that the job waits for a person, then take the next ready ticket.');
    expect(s.tickets).toHaveLength(2);
    const [human, merged] = s.tickets;
    const jobId = jobsOf(first)[0]?.id;
    expect(human).toMatchObject({ ticketId: first, outcome: 'needs-human', jobId });
    expect(human?.reason).toContain('two designs are possible');
    expect(human?.next).toContain(`orch do ${ticketKey(first)}`);
    expect(merged).toMatchObject({ ticketId: second, outcome: 'done' });
    expect(s).toMatchObject({ blocked: 1, completed: 1 });
    expect(getJob(store.db, jobId ?? '')).toMatchObject({
      stage: 'needs-human',
      ownerSession: null,
    });
    expect(l.calls.filter((c) => c.jobId === jobId)).toHaveLength(1);
    expect(status(second)).toBe('done');
    expect(merges()).toHaveLength(1);
    expect(s.reason).toBe('no ready ticket is left (1 waits for a person)');
    expect(summaryExitCode(s)).toBe(1);
    const text = formatSummary(s);
    expect(text).toContain(
      `${ticketKey(first)} needs-human: job ${jobId ?? ''} waits for a person`,
    );
    expect(text).toContain(`     next: ${human?.next ?? ''}`);
  });

  it('passes over a repository where merging is not enabled, and says how to enable it', async () => {
    setMergeAuthorization(store, clone, false);
    const id = ticket('Not opted in');
    const l = launcher(done);

    const s = await queue(l);

    expect(l.calls).toHaveLength(0);
    expect(jobsOf(id)).toHaveLength(0);
    expect(status(id)).toBe('open');
    expect(s.skipped).toHaveLength(1);
    expect(s.skipped[0]?.reason).toContain('orch factory config merge enable');
    expect(s.reason).toContain('passed over');
    const text = formatSummary(s);
    expect(text.indexOf('Passed over')).toBeGreaterThan(text.indexOf('Needs you (0)'));
    expect(text).toContain(`${ticketKey(id)} passed over: ${s.skipped[0]?.reason ?? '?'}`);
  });

  it('treats a lost claim as ordinary: the other job stays the only one', async () => {
    const id = ticket('Raced');
    let theirs = '';
    race.before = () => {
      theirs = dispatchJob(store, { ticket: id, session: 'someone-else', cwd: clone }).job.id;
    };
    const l = launcher(done);

    const s = await queue(l);

    expect(s.tickets[0]).toMatchObject({ outcome: 'claimed', jobId: theirs });
    expect(jobsOf(id).map((j) => j.id)).toEqual([theirs]);
    expect(l.calls).toHaveLength(0);
    expect(s.blocked).toBe(0);
  });
});

describe('orch do: one ticket, from wherever it is', () => {
  it('refuses a ticket whose dependency is not done, creating nothing', async () => {
    const dep = ticket('Dependency');
    const id = ticket('Dependent', { dependsOn: [dep] });
    const l = launcher(done);

    const s = await one(l, id);

    expect(s.tickets[0]).toMatchObject({ outcome: 'refused' });
    expect(s.tickets[0]?.reason).toContain('depends on');
    expect(jobsOf(id)).toHaveLength(0);
    expect(l.calls).toHaveLength(0);
    expect(s.blocked).toBe(1);
  });

  it('ends at a job that needs a person and starts no other ticket', async () => {
    const id = ticket('Escalates', { priority: 'P1' });
    const other = ticket('Other', { priority: 'P2' });
    let next = '';
    const l = launcher((job) => {
      escalate(job);
      next = runnerStatus(store).next;
    }, done);

    const s = await one(l, id);

    expect(next).toBe('Report that the job waits for a person, then exit.');
    expect(s.tickets.map((t) => t.outcome)).toEqual(['needs-human']);
    expect(l.calls).toHaveLength(1);
    expect(jobsOf(other)).toHaveLength(0);
  });

  it('refuses to start without the merge opt-in', async () => {
    setMergeAuthorization(store, clone, false);
    const id = ticket('Not opted in');
    const s = await one(launcher(done), id);
    expect(s.tickets[0]?.outcome).toBe('refused');
    expect(s.tickets[0]?.reason).toContain('orch factory config merge enable');
    expect(jobsOf(id)).toHaveLength(0);
  });

  it('continues the unfinished job instead of creating another', async () => {
    const id = ticket('Under way');
    const existing = dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job;
    const l = launcher(done);

    const s = await one(l, id);

    expect(l.calls.map((c) => c.jobId)).toEqual([existing.id]);
    expect(jobsOf(id)).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({ outcome: 'done', jobId: existing.id });
  });

  it('leaves a job another live session holds alone', async () => {
    const id = ticket('Held');
    const existing = dispatchJob(store, { ticket: id, session: 'human', cwd: clone }).job;
    claimJob(store, existing.id, { session: 'human' });
    const l = launcher(done);

    const s = await one(l, id);

    expect(s.tickets[0]?.outcome).toBe('blocked');
    expect(s.tickets[0]?.reason).toContain('human');
    expect(l.calls).toHaveLength(0);
    expect(getJob(store.db, existing.id).ownerSession).toBe('human');
    expect(jobsOf(id)).toHaveLength(1);
  });

  it('merges a completed job without starting Claude, and reports a done ticket as done', async () => {
    const id = ticket('Built already');
    finish(dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job);
    const l = launcher(idle);

    const s = await one(l, id);

    expect(l.calls).toHaveLength(0);
    expect(merges()).toHaveLength(1);
    expect(s.tickets[0]?.outcome).toBe('done');
    expect(status(id)).toBe('done');

    const again = await one(l, id);
    expect(again.tickets[0]).toMatchObject({ outcome: 'done', jobId: null });
    expect(merges()).toHaveLength(1);
  });

  it('records a merge GitHub already made instead of merging again', async () => {
    const id = ticket('Merged by hand');
    const job = finish(dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job);
    editPr(job, { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } });

    const s = await one(launcher(idle), id);

    expect(merges()).toHaveLength(0);
    expect(s.tickets[0]?.outcome).toBe('done');
    expect(getJob(store.db, job.id).prState).toBe('merged');
    expect(status(id)).toBe('done');
  });

  it('does not count a merge of an unverified head as success', async () => {
    const id = ticket('Merged at another head');
    const job = finish(dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job);
    editPr(job, { state: 'MERGED', headRefOid: OTHER, mergeCommit: { oid: 'c'.repeat(40) } });

    const s = await one(launcher(idle), id);

    expect(s.tickets[0]?.outcome).toBe('blocked');
    expect(s.tickets[0]?.reason).toContain('unverified merge');
    expect(s.completed).toBe(0);
    expect(status(id)).toBe('in-progress');
  });

  it('gives a ticket whose job was cancelled a new job: the cancel reopened it', async () => {
    const id = ticket('Cancelled');
    const job = dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job;
    cancelJob(store, job.id, { session: 'human', reason: 'not wanted' });
    expect(status(id)).toBe('open');
    const l = launcher(done);

    const s = await one(l, id);

    expect(s.tickets[0]?.outcome).toBe('done');
    expect(jobsOf(id).map((j) => j.status)).toEqual(['cancelled', 'completed']);
    expect(l.calls.map((c) => c.jobId)).toEqual([jobsOf(id)[1]?.id]);
  });

  it('passes over, for the rest of the session, a ticket whose job was cancelled during it', async () => {
    const id = ticket('Cancelled mid-run');
    const l = launcher((job) => {
      cancelJob(store, job.id, { session: 'human', reason: 'not wanted', force: true });
    });

    const s = await queue(l);

    expect(l.calls).toHaveLength(1);
    expect(s.tickets).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({ ticketId: id, outcome: 'blocked' });
    expect(s.tickets[0]?.next).toContain(`orch do ${ticketKey(id)}`);
    expect(s.tickets[0]?.next).not.toContain('orch ticket reopen');
    expect(status(id)).toBe('open');
    expect(jobsOf(id)).toHaveLength(1);
  });

  it('a session that exits without moving the job is retried once, then the ticket stops', async () => {
    const id = ticket('Stuck');
    const l = launcher(idle);

    const s = await one(l, id);

    expect(l.calls).toHaveLength(MAX_IDLE_LAUNCHES);
    expect(s.tickets[0]?.outcome).toBe('blocked');
    const job = jobsOf(id)[0];
    // Exit code 0 completed nothing; the job is neither cancelled nor held, so anyone resumes it.
    expect(job).toMatchObject({ stage: 'spec', ownerSession: null });
    expect(job?.status).not.toBe('cancelled');
    expect(job?.worktreePath).not.toBeNull();
    expect(status(id)).toBe('in-progress');
    expect(merges()).toHaveLength(0);
  });
});

describe('re-land', () => {
  it('runs the re-land job through the factory and merges it', async () => {
    const id = ticket('Conflicts once');
    const l = launcher((job) => {
      finish(job, { mergeable: 'CONFLICTING' });
    }, done);

    const s = await one(l, id);

    const [first, second] = jobsOf(id);
    expect(l.calls.map((c) => c.jobId)).toEqual([first?.id, second?.id]);
    expect(getJob(store.db, first?.id ?? '').supersededBy).toBe(second?.id);
    expect(s.tickets[0]).toMatchObject({ outcome: 'done', jobId: second?.id, relands: 1 });
    expect(s.relands).toBe(1);
    expect(merges()).toHaveLength(1);
    expect(status(id)).toBe('done');
  });

  it('stops at a second conflict: no third job', async () => {
    const id = ticket('Conflicts twice');
    const l = launcher((job) => {
      finish(job, { mergeable: 'CONFLICTING' });
    });

    const s = await one(l, id);

    expect(jobsOf(id)).toHaveLength(2);
    // Only a person resolves it: reported as waiting for one, with that step.
    expect(s.tickets[0]?.outcome).toBe('needs-human');
    expect(s.tickets[0]?.reason).toContain('second-conflict');
    expect(s.tickets[0]?.next).toContain('by hand');
    expect(merges()).toHaveLength(0);
    expect(status(id)).toBe('in-progress');
  });
});

describe('stop and resume', () => {
  it('stop next lets the current ticket finish and starts no other', async () => {
    const first = ticket('First', { priority: 'P1' });
    const second = ticket('Second', { priority: 'P2' });
    const l = launcher((job) => {
      expect(runnerStatus(store)).toMatchObject({
        state: 'running',
        pid: process.pid,
        current: { job: job.id, waiting: 'agent' },
      });
      expect(stopSession(store, 'next').pid).toBe(process.pid);
      expect(runnerStatus(store).next).toContain('then exit');
      finish(job);
    });

    const s = await queue(l);

    expect(s.reason).toContain('orch stop next');
    expect(s.stopped).toBe(false);
    expect(status(first)).toBe('done');
    expect(jobsOf(second)).toHaveLength(0);
    // Honoured and gone: the next session starts clean.
    expect(stopRequests(store.paths)).toEqual({ next: false, now: false });
  });

  it('stop ends the session now, keeps the job, and resume continues the same job and scope', async () => {
    const first = ticket('First', { priority: 'P1' });
    const second = ticket('Second', { priority: 'P2' });
    const h = hanging();

    const s = await queue(h, clone);

    expect(h.killed).toBe(1);
    expect(s).toMatchObject({ stopped: true, completed: 0 });
    const job = jobsOf(first)[0];
    expect(job?.status).not.toBe('cancelled');
    expect(job).toMatchObject({ stage: 'spec', ownerSession: null });
    expect(job?.worktreePath).not.toBeNull();
    expect(readSession(store.paths)).toMatchObject({
      finished: null,
      ticketId: first,
      jobId: job?.id,
      repo: clone,
      child: null,
    });
    expect(stopRequests(store.paths).now).toBe(false);
    expect(runnerStatus(store)).toMatchObject({ state: 'interrupted', pid: null });

    // A new session is refused while the interrupted one is there.
    await expect(queue(launcher(done))).rejects.toThrow(/interrupted.*orch resume/s);

    const l = launcher(done);
    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(l.calls[0]?.jobId).toBe(job?.id);
    expect(jobsOf(first)).toHaveLength(1);
    expect(r).toMatchObject({ stopped: false, completed: 2 });
    expect([status(first), status(second)]).toEqual(['done', 'done']);
    expect(readSession(store.paths)?.repo).toBe(clone);

    // It ended on its own: nothing to resume, and a new start is allowed.
    await expect(resumeSession(store, {}, quick)).rejects.toThrow(/nothing to resume/);
    expect(l.calls).toHaveLength(2);
  });

  it('a stop next requested before the interruption still holds after resume', async () => {
    const first = ticket('First', { priority: 'P1' });
    const second = ticket('Second', { priority: 'P2' });
    await queue(hanging());
    stopSession(store, 'next');
    expect(runnerStatus(store).stop.next).toBe(true);

    const l = launcher(done);
    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(r.reason).toContain('orch stop next');
    expect(status(first)).toBe('done');
    expect(jobsOf(second)).toHaveLength(0);
  });

  it('Ctrl+C (the abort signal) is the same stop', async () => {
    const id = ticket('Interrupted');
    const stop = new AbortController();
    const l = launcher();
    let killed = 0;
    l.launch = (input) => {
      let end: (e: { code: null; signal: string; error: null }) => void = () => undefined;
      const exited = new Promise<{ code: null; signal: string; error: null }>((r) => (end = r));
      l.calls.push({ ...input, jobId: '' });
      stop.abort();
      return {
        pid: DEAD_PID,
        startedAt: '',
        done: exited,
        kill: () => {
          killed += 1;
          end({ code: null, signal: 'SIGINT', error: null });
        },
      };
    };

    const s = await startSession(
      store,
      { mode: 'ticket', ticket: id },
      { launch: l.launch, signal: stop.signal, ...quick },
    );

    expect(killed).toBe(1);
    expect(s.stopped).toBe(true);
    expect(jobsOf(id)[0]?.status).not.toBe('cancelled');
  });

  const interrupted = (over: Partial<RunnerSession>): RunnerSession => ({
    pid: DEAD_PID,
    startedAt: new Date().toISOString(),
    beatAt: new Date().toISOString(),
    mode: 'queue',
    repo: null,
    ticket: null,
    ticketId: null,
    jobId: null,
    child: null,
    results: [],
    skipped: [],
    finished: null,
    ...over,
  });

  it('resume never starts a second Claude while the first may be alive', async () => {
    const id = ticket('Orphaned child');
    const job = dispatchJob(store, { ticket: id, session: RUNNER_SESSION, cwd: clone }).job;
    // The controller died; the child it started is this very process, recorded with its real
    // start time, so the OS lookup (real here) confirms it is the original.
    const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
    writeSession(
      store.paths,
      interrupted({ ticketId: id, jobId: job.id, child: { pid: process.pid, startedAt } }),
    );
    const l = launcher(done);

    const refusal = resumeSession(store, {}, { launch: l.launch, ...quick });
    await expect(refusal).rejects.toThrow(/is still running|may still be running/);
    await expect(refusal).rejects.toThrow(`PID ${String(process.pid)}`);
    await expect(refusal).rejects.toThrow(startedAt);
    expect(() => stopSession(store, 'now')).toThrow(/does not signal a PID/);
    expect(() => stopSession(store, 'now')).toThrow(startedAt);
    expect(l.calls).toHaveLength(0);
    expect(runnerStatus(store)).toMatchObject({
      state: 'interrupted',
      current: { childPid: process.pid, childAlive: true },
    });
    expect(controllerPid(store.paths)).toBeNull();

    // The person says that PID is something else now.
    const r = await resumeSession(store, { force: true }, { launch: l.launch, ...quick });
    expect(l.calls.map((c) => c.jobId)).toEqual([job.id]);
    expect(r.completed).toBe(1);
    expect(jobsOf(id)).toHaveLength(1);
  }, 300_000);

  it('a PID another program reused, by its start time, blocks neither stop nor resume', async () => {
    const id = ticket('Reused PID');
    const job = dispatchJob(store, { ticket: id, session: RUNNER_SESSION, cwd: clone }).job;
    const startedAt = new Date().toISOString();
    const orphan = interrupted({
      ticketId: id,
      jobId: job.id,
      child: { pid: process.pid, startedAt },
    });
    // The live process at that PID started an hour after the child was launched.
    const reused = () => Date.parse(startedAt) + 3_600_000;

    writeSession(store.paths, orphan);
    expect(stopSession(store, 'now', 0, reused).message).toMatch(/discarded/);

    writeSession(store.paths, orphan);
    const l = launcher(done);
    const r = await resumeSession(store, {}, { launch: l.launch, startTime: reused, ...quick });
    expect(l.calls.map((c) => c.jobId)).toEqual([job.id]);
    expect(r.completed).toBe(1);
  });

  it('a child whose start time cannot be read still blocks stop and resume', async () => {
    const id = ticket('Unknown identity');
    const job = dispatchJob(store, { ticket: id, session: RUNNER_SESSION, cwd: clone }).job;
    const startedAt = new Date().toISOString();
    writeSession(
      store.paths,
      interrupted({ ticketId: id, jobId: job.id, child: { pid: process.pid, startedAt } }),
    );
    const unknown = () => null;
    const l = launcher(done);

    await expect(
      resumeSession(store, {}, { launch: l.launch, startTime: unknown, ...quick }),
    ).rejects.toThrow(/identity unknown/);
    expect(() => stopSession(store, 'now', 0, unknown)).toThrow(
      `PID ${String(process.pid)}, recorded start ${startedAt}`,
    );
    expect(l.calls).toHaveLength(0);
    expect(readSession(store.paths)?.finished).toBeNull();
  });

  it('a controller that died before dispatching anything resumes into its queue', async () => {
    const id = ticket('Never started');
    writeSession(store.paths, interrupted({}));
    const l = launcher(done);
    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });
    expect(r.completed).toBe(1);
    expect(jobsOf(id)).toHaveLength(1);
  });

  it('a resumed ticket that then needs a person is passed over for the next ready one', async () => {
    const first = ticket('In flight', { priority: 'P1' });
    const second = ticket('Next', { priority: 'P2' });
    const job = dispatchJob(store, { ticket: first, session: RUNNER_SESSION, cwd: clone }).job;
    writeSession(store.paths, interrupted({ ticketId: first, jobId: job.id }));
    const l = launcher(escalate, done);

    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(r.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'needs-human'],
      [second, 'done'],
    ]);
    expect(l.calls.map((c) => c.jobId)).toEqual([job.id, jobsOf(second)[0]?.id]);
    expect(r.reason).toBe('no ready ticket is left (1 waits for a person)');
  });

  it('orch stop discards an interrupted session and hands its job back', async () => {
    const id = ticket('Discarded');
    const job = dispatchJob(store, { ticket: id, session: RUNNER_SESSION, cwd: clone }).job;
    claimJob(store, job.id, { session: RUNNER_SESSION });
    writeSession(store.paths, interrupted({ ticketId: id, jobId: job.id }));
    requestStop(store.paths, 'next');

    const stopped = stopSession(store, 'now');

    expect(stopped.message).toContain('discarded');
    expect(getJob(store.db, job.id)).toMatchObject({ ownerSession: null, stage: 'spec' });
    expect(getJob(store.db, job.id).status).not.toBe('cancelled');
    expect(readSession(store.paths)?.finished?.reason).toContain('discarded');
    expect(stopRequests(store.paths)).toEqual({ next: false, now: false });
    expect(runnerStatus(store).state).toBe('idle');
    expect(() => stopSession(store, 'next')).toThrow(/nothing to stop/);

    // orch do picks the same job up again.
    const l = launcher(done);
    const s = await one(l, id);
    expect(l.calls.map((c) => c.jobId)).toEqual([job.id]);
    expect(s.completed).toBe(1);
  });
});

describe('one controller at a time', () => {
  it('a second start cannot take the controller; a dead holder is replaced', async () => {
    const release = acquireRunnerLock(store.paths);
    expect(controllerPid(store.paths)).toBe(process.pid);
    expect(() => acquireRunnerLock(store.paths)).toThrow(/already running/);
    await expect(queue(launcher(done))).rejects.toThrow(/already running/);
    expect(() => stopSession(store, 'next')).not.toThrow();
    release();
    expect(controllerPid(store.paths)).toBeNull();

    writeFileSync(
      join(runnerPaths(store.paths).lock, '7'),
      JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }),
    );
    expect(controllerPid(store.paths)).toBeNull();
    const again = acquireRunnerLock(store.paths);
    expect(controllerPid(store.paths)).toBe(process.pid);
    again();
  });

  it('a lock whose live PID stopped beating long ago (a reused PID) is stale', () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    mkdirSync(runnerPaths(store.paths).lock, { recursive: true });
    writeFileSync(
      join(runnerPaths(store.paths).lock, '7'),
      JSON.stringify({ pid: process.pid, startedAt: old }),
    );
    expect(controllerPid(store.paths)).toBeNull();
    acquireRunnerLock(store.paths)();
  });
});

describe('ticket lifecycle', () => {
  it('a reopened ticket gets a new job; unchecked boxes keep a merged ticket open', async () => {
    const id = ticket('With a checklist', { body: '- [ ] set the flag on GitHub\n' });
    const l = launcher(done);

    const s = await one(l, id);

    expect(merges()).toHaveLength(1);
    expect(s.tickets[0]?.outcome).toBe('blocked');
    expect(s.tickets[0]?.reason).toContain('the ticket stays in-progress');
    // Merged and verified: the step is the boxes and ticket done, never a retry.
    const k = ticketKey(id);
    expect(s.tickets[0]?.code).toBe('ticket-open');
    expect(s.tickets[0]?.next).toContain('tick the remaining boxes');
    expect(s.tickets[0]?.next).toContain('move them to a follow-up ticket');
    expect(s.tickets[0]?.next).toContain(`orch ticket done ${k}`);
    expect(s.tickets[0]?.next).not.toContain('tries again');
    expect(status(id)).toBe('in-progress');

    ticketAction(store, id, { action: 'reopen' });
    await one(l, id);
    expect(jobsOf(id)).toHaveLength(2);
    expect(l.calls).toHaveLength(2);
  });
});
