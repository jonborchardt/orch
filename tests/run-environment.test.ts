/**
 * A rebuilt `orch` or a `factory.json` that fails validation ends the run resumably, never as a
 * ticket failure (decision 2026-11-25-environment-stops-are-resumable). Uses tests/run-fixture.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { summaryExitCode } from '../src/cli/run.ts';
import { endsRun } from '../src/core/workflow.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { configPath } from '../src/ops/factory.ts';
import { REBUILT_REASON, resumeSession, startSession } from '../src/ops/run.ts';
import { readSession, writeSession } from '../src/ops/runner-state.ts';
import { getJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import {
  type Act,
  clone,
  DEAD_PID,
  done,
  jobsOf,
  type Launcher,
  launcher,
  quick,
  status,
  store,
  ticket,
} from './run-fixture.ts';

const BAD = 'factory.json: model for "spec-writer" must be one of';

/** Make `factory.json` invalid the way the incident did; returns the undo. */
function breakConfig(): () => void {
  const file = configPath(store);
  const good = readFileSync(file, 'utf8');
  const raw = JSON.parse(good) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, models: { 'spec-writer': 'gpt-9' } }));
  return () => {
    writeFileSync(file, good);
  };
}

/** A build identity that reads `v1` the first `n` times and `v2` after. */
function rebuiltAfter(n: number): () => string {
  let reads = 0;
  return () => (++reads > n ? 'v2' : 'v1');
}

const run = (l: Launcher, build?: () => string | null) =>
  startSession(store, { mode: 'queue' }, { launch: l.launch, ...quick, build });

describe('a rebuilt orch stops the session resumably', () => {
  it('stops before the child launch, leaves the job untouched, and orch resume continues it', async () => {
    const first = ticket('In flight', { priority: 'P1' });
    const second = ticket('Waits', { priority: 'P2' });
    const l = launcher(done);

    // Reads: drive's start, the queue's pre-ticket check, then the launch check sees v2.
    const s = await run(l, rebuiltAfter(2));

    expect(l.calls).toHaveLength(0);
    expect(s.reason).toContain(REBUILT_REASON);
    expect(s.tickets).toMatchObject([
      { ticketId: first, outcome: 'blocked', code: 'orch-rebuilt', next: 'orch resume' },
    ]);
    expect(summaryExitCode(s)).toBe(1);
    const [job] = jobsOf(first);
    const jobId = job?.id ?? '';
    expect(readSession(store.paths)).toMatchObject({ finished: null, ticketId: first, jobId });
    const after = getJob(store.db, jobId);
    expect([after.stage, after.status, after.round, after.ownerSession]).toEqual([
      job?.stage,
      job?.status,
      job?.round,
      null,
    ]);
    expect(jobsOf(second)).toHaveLength(0);

    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });
    expect(l.calls[0]?.jobId).toBe(jobId);
    expect(jobsOf(first).map((j) => j.id)).toEqual([jobId]);
    expect(r.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
  });

  it('a rebuild seen before the next ticket dispatches nothing for it', async () => {
    const first = ticket('Runs', { priority: 'P1' });
    const second = ticket('Not started', { priority: 'P2' });
    let version = 'v1';
    const rebuildThenFinish: Act = (job, input) => {
      version = 'v2';
      done(job, input);
    };

    const s = await run(launcher(rebuildThenFinish), () => version);

    expect(s.reason).toBe(REBUILT_REASON);
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([[first, 'done']]);
    expect(jobsOf(second)).toHaveLength(0);
    expect(readSession(store.paths)).toMatchObject({ finished: null, ticketId: null });
  });

  it('no build stamp at start never stops the run', async () => {
    const id = ticket('Runs anyway');
    let reads = 0;
    const s = await run(launcher(done), () => (reads++ === 0 ? null : 'v2'));
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([[id, 'done']]);
    expect(readSession(store.paths)?.finished).not.toBeNull();
  });
});

describe('a bad factory.json stops the session resumably', () => {
  it('is bad-config, not error, and the ticket is continued on resume', async () => {
    expect([endsRun('bad-config'), endsRun('orch-rebuilt')]).toEqual([true, true]);
    const first = ticket('Breaks the config', { priority: 'P1' });
    const second = ticket('Waits', { priority: 'P2' });
    let undo: () => void = () => undefined;
    // The job finishes, then the merge's config read fails: runTicket's catch.
    const breaks: Act = (job, input) => {
      undo = breakConfig();
      done(job, input);
    };
    const l = launcher(breaks, done);

    const s = await run(l);

    expect(s.reason).toContain(BAD);
    expect(s.tickets).toMatchObject([
      { ticketId: first, outcome: 'blocked', code: 'bad-config', next: 'orch resume' },
    ]);
    expect(readSession(store.paths)).toMatchObject({ finished: null, ticketId: first });
    expect(jobsOf(second)).toHaveLength(0);

    undo();
    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });
    expect(r.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
    expect(status(first)).toBe('done');
  });

  it('after a stop before any ticket, orch resume continues the stranded ticket first', async () => {
    const stranded = ticket('Stranded', { priority: 'P3' });
    const job = dispatchJob(store, { ticket: stranded, session: 'earlier', cwd: clone }).job;
    store.db
      .update(jobs)
      .set({ stage: 'build', status: 'pending', ownerSession: null, ownerToken: null })
      .where(eq(jobs.id, job.id))
      .run();
    const ready = ticket('Ready', { priority: 'P1' });
    const undo = breakConfig();
    const l = launcher(done);

    const s = await run(l);

    expect(s.reason).toContain(BAD);
    expect(s.tickets).toHaveLength(0);
    expect(l.calls).toHaveLength(0);
    expect(readSession(store.paths)).toMatchObject({ finished: null, ticketId: null });

    // A run-wide result on record does not pass the ticket over either.
    const session = readSession(store.paths);
    if (session === null) throw new Error('no session');
    const ts = new Date().toISOString();
    writeSession(store.paths, {
      ...session,
      pid: DEAD_PID,
      beatAt: ts,
      results: [
        {
          ticketId: stranded,
          title: 'Stranded',
          repo: 'x',
          jobId: job.id,
          outcome: 'blocked',
          code: 'bad-config',
          reason: 'earlier',
          relands: 0,
          next: 'orch resume',
        },
      ],
    });
    undo();
    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(l.calls[0]?.jobId).toBe(job.id);
    expect(jobsOf(stranded).map((j) => j.id)).toEqual([job.id]);
    expect(r.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [stranded, 'done'],
      [ready, 'done'],
    ]);
  });
});
