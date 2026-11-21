/**
 * A controller that lost its lock stops (ticket 0096). The machine sleeps past the stale
 * threshold, a starter on wake takes the next lock generation, and the first controller must then
 * make no job mutation and write no runner state. The ci-stage case is in run-ownership-ci.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LostLockError } from '../src/core/errors.ts';
import { runnerPaths } from '../src/core/paths.ts';
import type { ClaudeChild } from '../src/integrations/claude-session.ts';
import { RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import {
  acquireRunnerLock,
  readSession,
  type RunnerSession,
  writeSession,
} from '../src/ops/runner-state.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import { done, jobsOf, launcher, merges, quick, store, ticket } from './run-fixture.ts';

const HOURS_AGO = () => new Date(Date.now() - 3 * 3600_000).toISOString();

/** The session record as the sleeping controller last wrote it, hours before the wake. */
function slept(): void {
  const base: RunnerSession = readSession(store.paths) ?? {
    pid: process.pid,
    startedAt: HOURS_AGO(),
    beatAt: HOURS_AGO(),
    mode: 'queue',
    repo: null,
    ticket: null,
    ticketId: null,
    jobId: null,
    child: null,
    results: [],
    skipped: [],
    finished: null,
  };
  writeSession(store.paths, { ...base, beatAt: HOURS_AGO() });
}

/** A starter on wake: it finds the live controller stale and takes the next generation. */
function takeOver() {
  slept();
  acquireRunnerLock(store.paths); // held for good, as by a starter that is still running
  const dir = runnerPaths(store.paths).lock;
  const top = String(Math.max(...readdirSync(dir).map(Number).filter(Number.isInteger)));
  return {
    runner: readFileSync(runnerPaths(store.paths).state),
    lock: readFileSync(join(dir, top)),
    lockFile: join(dir, top),
  };
}

describe('controller: a lost lock', () => {
  it('a stale-looking live holder is superseded, and its check says so (AC1)', () => {
    const first = acquireRunnerLock(store.paths);
    slept();
    expect(first.owned()).toBe(true);
    const second = acquireRunnerLock(store.paths);
    expect(readdirSync(runnerPaths(store.paths).lock).sort()).toEqual(['1', '2']);
    expect(first.owned()).toBe(false);
    expect(second.owned()).toBe(true);
    first(); // releasing its own generation leaves the new holder alone
    expect(second.owned()).toBe(true);
    second();
  });

  it('kills the running child and writes nothing more (AC2, AC3)', async () => {
    const id = ticket('Sleeps through');
    let launches = 0;
    let killed = 0;
    const at: { snap?: ReturnType<typeof takeOver> & { events: unknown; job: unknown } } = {};
    let jobId = '';
    const launch = (): ClaudeChild => {
      launches += 1;
      let end: (e: { code: null; signal: string; error: null }) => void = () => undefined;
      return {
        pid: 2 ** 31 - 1,
        startedAt: new Date().toISOString(),
        done: new Promise((r) => (end = r)),
        kill: () => {
          killed += 1;
          end({ code: null, signal: 'SIGTERM', error: null });
        },
      };
    };
    let pauses = 0;
    const sleep = () => {
      pauses += 1;
      if (pauses === 3) {
        jobId = jobsOf(id)[0]?.id ?? '';
        at.snap = {
          ...takeOver(),
          events: listEvents(store.db, jobId, 1000),
          job: getJob(store.db, jobId),
        };
      }
      return Promise.resolve();
    };

    await expect(
      startSession(store, { mode: 'ticket', ticket: id }, { launch, sleep, pollMs: 1 }),
    ).rejects.toBeInstanceOf(LostLockError);

    const s = at.snap;
    if (s === undefined) throw new Error('the takeover never happened');
    expect(launches).toBe(1);
    expect(killed).toBe(1);
    expect(listEvents(store.db, jobId, 1000)).toEqual(s.events);
    expect(getJob(store.db, jobId)).toEqual(s.job);
    expect(getJob(store.db, jobId).ownerSession).toBe(RUNNER_SESSION);
    expect(readFileSync(runnerPaths(store.paths).state)).toEqual(s.runner);
    expect(readFileSync(s.lockFile)).toEqual(s.lock);
  });

  it('lost before the merge: nothing is merged (AC5)', async () => {
    const id = ticket('Lost after the child');
    const take = (line: string) => {
      if (line.startsWith('  claude: exited')) takeOver();
    };
    await expect(
      startSession(
        store,
        { mode: 'ticket', ticket: id },
        { launch: launcher(done).launch, log: take, ...quick },
      ),
    ).rejects.toBeInstanceOf(LostLockError);
    expect(merges()).toHaveLength(0);
  });

  it('lost between tickets: the next one is not dispatched (AC5)', async () => {
    const first = ticket('First');
    const second = ticket('Second');
    const take = (line: string) => {
      if (line.includes(': done: merged')) takeOver();
    };
    await expect(
      startSession(
        store,
        { mode: 'queue', repo: null },
        { launch: launcher(done).launch, log: take, ...quick },
      ),
    ).rejects.toBeInstanceOf(LostLockError);
    // One ticket merged, and the other never got a job.
    expect(merges()).toHaveLength(1);
    expect(jobsOf(first).length + jobsOf(second).length).toBe(1);
  });
});
