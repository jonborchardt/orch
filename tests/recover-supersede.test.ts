/**
 * A recovery worker that has lost its PID file to another worker stops before its next pass and
 * before its next job episode, and writes nothing more: no episode, no mail, no status, no log
 * (ticket 0111, decision 2026-11-24-recovery-worker-checks-its-pid-file).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { recoveryPaths } from '../src/core/paths.ts';
import { holdPidFile, recoverPass, runWorker } from '../src/ops/recover.ts';
import { listEvents } from '../src/storage/events.ts';
import { releaseJob } from '../src/storage/jobs.ts';
import { type Ctx, start, toCi } from './drive.ts';
import { checks, clone, run, shim, store } from './ci-fixture.ts';

const SUPERSEDED = {
  online: false,
  probeError: 'superseded: another recovery worker holds the PID file',
  jobs: [],
  nextSeconds: null,
};

const recoveryEvents = (c: Ctx) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type.startsWith('recovery.'));

/** A ci-stage job whose session is gone: recoverable on the next pass. */
function stranded(title: string): Ctx {
  const c = start(store, clone, title);
  toCi(store, c);
  releaseJob(store, c.id, { token: c.token });
  return c;
}

function nothingRecorded(): void {
  const files = recoveryPaths(store.paths);
  expect(existsSync(files.status)).toBe(false);
  expect(existsSync(files.log)).toBe(false);
}

describe('superseded recovery worker', () => {
  it('returns before its next pass once another worker holds the PID file', async () => {
    const c = stranded('Stranded');
    const hold = holdPidFile(store.paths);
    // A second worker took the file over (say, after the first slept past the stale limit).
    const other = process.pid + 1;
    writeFileSync(
      recoveryPaths(store.paths).pid,
      JSON.stringify({ pid: other, startedAt: new Date().toISOString() }),
    );
    const calls = shim.read().calls.length;

    const pass = await runWorker(store, { owned: hold.owned, beat: hold.beat });

    expect(pass).toMatchObject(SUPERSEDED);
    expect(recoveryEvents(c)).toEqual([]);
    expect(shim.read().calls).toHaveLength(calls);
    nothingRecorded();
    // The superseded worker never rewrites the file it lost.
    expect(hold.owned()).toBe(false);
    hold.release();
    expect(existsSync(recoveryPaths(store.paths).pid)).toBe(true);
  });

  it('starts no further episode once it loses the file mid-pass', async () => {
    checks('*', [run('test', 'success')]);
    const jobs = [stranded('First'), stranded('Second')];
    const attempts = () => jobs.flatMap(recoveryEvents).length;
    /** Ownership that is lost as soon as one more episode has run. */
    const oneEpisode = () => {
      const base = attempts();
      return () => attempts() === base;
    };

    const pass = recoverPass(store, oneEpisode());
    const entries = jobs.map((c) => pass.jobs.find((j) => j.jobId === c.id));
    expect(entries.filter((e) => e?.action === 'reconciled')).toHaveLength(1);
    const skipped = jobs.filter((_, i) => entries[i]?.action === 'none');
    expect(skipped).toHaveLength(1);
    expect(skipped.flatMap(recoveryEvents)).toEqual([]);

    // Through the worker: the same check gives the superseded value and records nothing.
    jobs.push(stranded('Third'));
    const before = attempts();
    expect(await runWorker(store, { owned: oneEpisode() })).toMatchObject(SUPERSEDED);
    expect(attempts()).toBeGreaterThan(before);
    nothingRecorded();
  });
});
