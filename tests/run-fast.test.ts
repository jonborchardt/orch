/**
 * `orch do <ticket> --fast` (decision 2026-11-23-fast-mode): the controller creates a fast job for
 * that ticket, keeps the flag across `orch resume`, and never changes the mode of a job that
 * already exists. The Claude child is the run-fixture stand-in; nothing reaches the network.
 */
import { describe, expect, it } from 'vitest';

import { RUN_HELP, runRunner } from '../src/cli/run.ts';
import { UsageError } from '../src/core/errors.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { resumeSession, RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { readSession, type RunnerSession, writeSession } from '../src/ops/runner-state.ts';
import type { Job } from '../src/storage/schema.ts';
import {
  clone,
  DEAD_PID,
  eventsOf,
  idle,
  jobsOf,
  launcher,
  one,
  quick,
  store,
  ticket,
} from './run-fixture.ts';

const fastDo = (id: number, log: (line: string) => void = () => undefined) => {
  const seen: Job[] = [];
  const l = launcher((job) => seen.push(job), idle);
  return {
    seen,
    done: startSession(
      store,
      { mode: 'ticket', ticket: id, fast: true },
      { launch: l.launch, log, ...quick },
    ),
  };
};

describe('orch do --fast', () => {
  it('creates a fast job in build; without --fast the job is full in spec', async () => {
    const fast = ticket('Fix a typo');
    const run = fastDo(fast);
    await run.done;
    // What the first Claude child was given: a fast job in build.
    expect(run.seen[0]).toMatchObject({ mode: 'fast', stage: 'build', ticketId: fast });
    const job = jobsOf(fast)[0];
    expect(job?.mode).toBe('fast');
    expect(eventsOf(job?.id ?? '', 'job.created')[0]?.payload).toMatchObject({ mode: 'fast' });
    expect(readSession(store.paths)?.fast).toBe(true);

    const full = ticket('A feature');
    await one(launcher(idle), full);
    expect(jobsOf(full)[0]).toMatchObject({ mode: 'full', stage: 'spec' });
    expect(eventsOf(jobsOf(full)[0]?.id ?? '', 'job.created')[0]?.payload).toMatchObject({
      mode: 'full',
    });
    expect(readSession(store.paths)?.fast).toBeUndefined();
  });

  it('continues an unfinished full job unchanged and says --fast did not apply', async () => {
    const id = ticket('Already started');
    const existing = dispatchJob(store, { ticket: id, session: RUNNER_SESSION, cwd: clone }).job;
    const lines: string[] = [];
    await fastDo(id, (line) => lines.push(line)).done;
    expect(jobsOf(id).map((j) => [j.id, j.mode])).toEqual([[existing.id, 'full']]);
    expect(lines).toContain(
      `  job ${existing.id}: --fast applies only to a new job; this one continues in its recorded mode, full`,
    );
  });

  it('--fast belongs to orch do only: orch start and orch resume refuse it', async () => {
    for (const command of ['start', 'resume'] as const) {
      await expect(runRunner(command, [], { fast: true })).rejects.toThrow(UsageError);
    }
    expect(RUN_HELP).toContain('do <ticket-id> [--fast]');
  });

  it('orch resume of an interrupted --fast session still creates a fast job', async () => {
    const id = ticket('Interrupted before dispatch');
    const ts = new Date().toISOString();
    const session: RunnerSession = {
      pid: DEAD_PID,
      startedAt: ts,
      beatAt: ts,
      mode: 'ticket',
      repo: null,
      ticket: id,
      fast: true,
      ticketId: id,
      jobId: null,
      child: null,
      results: [],
      skipped: [],
      finished: null,
    };
    writeSession(store.paths, session);
    await resumeSession(store, {}, { launch: launcher(idle).launch, ...quick });
    expect(jobsOf(id)[0]).toMatchObject({ mode: 'fast', stage: 'build' });
  });
});
