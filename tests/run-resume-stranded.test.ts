/**
 * Between tickets the queue first continues a stranded in-progress ticket (its job released,
 * pending or running, not waiting for a person, no live lease), then takes the next ready one
 * (decision 2026-11-24-queue-resumes-stranded-tickets). Uses tests/run-fixture.ts.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { formatStatus } from '../src/cli/run.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { resumeSession, runnerStatus } from '../src/ops/run.ts';
import { type RunnerSession, writeSession } from '../src/ops/runner-state.ts';
import { claimJob, getJob } from '../src/storage/jobs.ts';
import { type Job, jobs } from '../src/storage/schema.ts';
import {
  clone,
  DEAD_PID,
  done,
  eventsOf,
  finish,
  idle,
  jobsOf,
  launcher,
  queue,
  quick,
  store,
  ticket,
} from './run-fixture.ts';

/** A ticket's job a person sent back and released: in progress, build/pending, no owner. */
function strand(id: number, patch: Partial<Job> = {}): Job {
  const job = dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job;
  store.db
    .update(jobs)
    .set({ stage: 'build', status: 'pending', ...patch })
    .where(eq(jobs.id, job.id))
    .run();
  return getJob(store.db, job.id);
}

const session = (o: Partial<RunnerSession>): RunnerSession => {
  const ts = new Date().toISOString();
  return {
    pid: DEAD_PID,
    startedAt: ts,
    beatAt: ts,
    mode: 'queue',
    repo: null,
    ticket: null,
    ticketId: null,
    jobId: null,
    child: null,
    results: [],
    skipped: [],
    finished: null,
    ...o,
  };
};

describe('the queue resumes stranded in-progress tickets first', () => {
  it('continues the released job before a higher-priority ready ticket, and records the pick', async () => {
    const stranded = ticket('Sent back', { priority: 'P3' });
    const job = strand(stranded);
    const ready = ticket('Ready', { priority: 'P1' });
    const l = launcher(done);

    const s = await queue(l);

    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [stranded, 'done'],
      [ready, 'done'],
    ]);
    expect(jobsOf(stranded).map((j) => j.id)).toEqual([job.id]);
    expect(l.calls[0]?.jobId).toBe(job.id);
    expect(eventsOf(job.id, 'runner.session')[0]?.payload['pick']).toBe('resume');
    const readyJob = jobsOf(ready)[0]?.id ?? '';
    expect(eventsOf(readyJob, 'runner.session')[0]?.payload['pick']).toBe('ready');
  });

  it('passes a stranded ticket over once when it ends again, and not again after orch resume', async () => {
    const stranded = ticket('Still stuck', { priority: 'P1' });
    const job = strand(stranded);
    const ready = ticket('Ready', { priority: 'P2' });
    const l = launcher(idle, idle, done);

    const s = await queue(l);

    expect(s.tickets.map((t) => [t.ticketId, t.outcome, t.code])).toEqual([
      [stranded, 'blocked', 'no-progress'],
      [ready, 'done', 'done'],
    ]);
    expect(l.calls.filter((c) => c.jobId === job.id)).toHaveLength(2);
    expect(eventsOf(job.id, 'runner.stopped').at(-1)?.payload).toMatchObject({
      code: 'no-progress',
      pick: 'resume',
    });
  });

  it('orch resume keeps a passed-over stranded ticket passed over', async () => {
    const stranded = ticket('Still stuck', { priority: 'P1' });
    const job = strand(stranded);
    const ready = ticket('Ready', { priority: 'P2' });
    const blocked = {
      ticketId: stranded,
      title: 'Still stuck',
      repo: 'x',
      jobId: job.id,
      outcome: 'blocked' as const,
      code: 'no-progress',
      reason: 'earlier',
      relands: 0,
      next: null,
    };
    writeSession(store.paths, session({ results: [blocked] }));
    const l = launcher(done);

    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(l.calls.map((c) => c.jobId)).not.toContain(job.id);
    expect(r.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [stranded, 'blocked'],
      [ready, 'done'],
    ]);
  });

  it('never picks a completed, needs-human, blocked, or live-held job', async () => {
    const merged = ticket('Merged, boxes open', { priority: 'P1' });
    finish(dispatchJob(store, { ticket: merged, session: 'earlier', cwd: clone }).job);
    strand(ticket('Waits for a person', { priority: 'P1' }), { stage: 'needs-human' });
    strand(ticket('Blocked', { priority: 'P1' }), { status: 'blocked' });
    const held = strand(ticket('Held', { priority: 'P1' }));
    claimJob(store, held.id, { session: 'human' });
    const ready = ticket('Ready', { priority: 'P2' });
    const l = launcher(done);

    const s = await queue(l);

    expect(s.tickets.map((t) => t.ticketId)).toEqual([ready]);
    expect(jobsOf(merged)).toHaveLength(1);
  });

  it('orch status reports the pick of the ticket in flight', () => {
    writeSession(store.paths, session({ ticketId: 42, pick: 'resume' }));

    const st = runnerStatus(store);

    expect(st.controllers[0]?.current?.pick).toBe('resume');
    expect(formatStatus(st)).toContain('ticket      0042 (pick resume)');
    writeSession(store.paths, session({ ticketId: 42 })); // an older record has no pick
    expect(runnerStatus(store).controllers[0]?.current?.pick).toBeNull();
  });
});
