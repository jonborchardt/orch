/**
 * A controller that loses its lock while it waits for CI (ticket 0096): it stops without another
 * read of GitHub, keeps the runner's lease for the controller that took over, and writes nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LostLockError } from '../src/core/errors.ts';
import { jobArtifactDir, runnerPaths } from '../src/core/paths.ts';
import type { ClaudeChild, LaunchInput } from '../src/integrations/claude-session.ts';
import { setMergeAuthorization } from '../src/ops/merge.ts';
import { runnerScope } from '../src/ops/repo.ts';
import { RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { acquireRunnerLock, readSession, writeSession } from '../src/ops/runner-state.ts';
import { addTicket } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import { ticketJobs } from '../src/storage/tickets.ts';
import { checks, clone, run, shim, store } from './ci-fixture.ts';
import { type Ctx, head, toCi } from './drive.ts';

/** The generation the starter on wake took; the controller under test holds 1. */
const lockTwo = () => join(runnerPaths(store.paths, slot()).lock, '2');
/** The slot `orch do` runs in: its ticket's repository. */
const slot = () => runnerScope(clone).key;

describe('controller: a lost lock in the ci stage', () => {
  it('stops in the CI wait without another read or a release (AC4)', async () => {
    setMergeAuthorization(store, clone, true);
    const id = addTicket(store, { title: 'Waits for CI', repo: clone }).id;
    const launch = (input: LaunchInput): ClaudeChild => {
      const jobId = /job-[0-9a-f]{8}/.exec(input.prompt)?.[0] ?? '';
      const { token } = claimJob(store, jobId, { session: RUNNER_SESSION });
      const wt = getJob(store.db, jobId).worktreePath ?? '';
      const c: Ctx = { id: jobId, token, dir: jobArtifactDir(jobId, store.paths), wt };
      toCi(store, c);
      checks(head(wt), [run('test', null, 'queued')]);
      releaseJob(store, jobId, { token });
      return {
        pid: 2 ** 31 - 1,
        startedAt: new Date().toISOString(),
        done: Promise.resolve({ code: 0, signal: null, error: null }),
        kill: () => undefined,
      };
    };
    const at: { snap?: { events: unknown; runner: Buffer; lock: Buffer; calls: number } } = {};
    // The controller's own first read of CI, not one made while the session delivered the PR.
    const polled = () => {
      const job = ticketJobs(store.db, id)[0];
      return job?.ownerSession === RUNNER_SESSION && job.stage === 'ci' ? job : undefined;
    };
    const sleep = () => {
      const job = polled();
      if (job !== undefined && at.snap === undefined) {
        // The machine slept past the stale threshold; a starter on wake takes the next generation.
        const s = readSession(store.paths, slot());
        if (s === null) throw new Error('no session record');
        writeSession(
          store.paths,
          { ...s, beatAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
          slot(),
        );
        acquireRunnerLock(store.paths, slot());
        at.snap = {
          events: listEvents(store.db, job.id, 1000),
          runner: readFileSync(runnerPaths(store.paths, slot()).state),
          lock: readFileSync(lockTwo()),
          calls: shim.read().calls.length,
        };
      }
      return Promise.resolve();
    };

    await expect(
      startSession(store, { mode: 'ticket', ticket: id }, { launch, sleep, pollMs: 1 }),
    ).rejects.toBeInstanceOf(LostLockError);

    const s = at.snap;
    const job = ticketJobs(store.db, id)[0];
    if (s === undefined || job === undefined) throw new Error('the takeover never happened');
    expect(listEvents(store.db, job.id, 1000)).toEqual(s.events);
    expect(job).toMatchObject({ stage: 'ci', ownerSession: RUNNER_SESSION });
    expect(readFileSync(runnerPaths(store.paths, slot()).state)).toEqual(s.runner);
    expect(readFileSync(lockTwo())).toEqual(s.lock);
    expect(shim.read().calls).toHaveLength(s.calls);
  });
});
