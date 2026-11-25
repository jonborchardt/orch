/**
 * The controller giving a ticket up in the ci stage, with a real job: the session delivers the PR
 * and exits, then CI never finishes, or GitHub cannot be read. Either way the stop is on the job's
 * own record, the runner's lease is gone, and the job, PR and ticket are what they were.
 */
import { describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import type { ClaudeChild, LaunchInput } from '../src/integrations/claude-session.ts';
import { setMergeAuthorization } from '../src/ops/merge.ts';
import {
  GITHUB_BACKOFF_SECONDS,
  RUNNER_SESSION,
  startSession,
  TRANSIENT_ATTEMPTS,
} from '../src/ops/run.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import { ticketJobs } from '../src/storage/tickets.ts';
import { checks, clone, ghCalls, run, shim, store } from './ci-fixture.ts';
import { type Ctx, head, toCi } from './drive.ts';

/** What a controller-level stop must leave alone. */
const kept = (j: Job) => ({
  stage: j.stage,
  status: j.status,
  round: j.round,
  ciRepairs: j.ciRepairs,
  prUrl: j.prUrl,
  prState: j.prState,
  branch: j.branch,
});

/** A CI observation budget small enough to exhaust quickly (production is `CI_MAX_POLLS`). */
const BUDGET = 3;

/** Run the ticket with a session that delivers the PR with a queued check, then `after`, and exits. */
async function stopAtCi(after: () => void = () => undefined, ciMaxPolls?: number) {
  setMergeAuthorization(store, clone, true);
  const id = addTicket(store, { title: 'Export CSV', repo: clone }).id;
  let launches = 0;
  let left: Job | undefined;
  const launch = (input: LaunchInput): ClaudeChild => {
    const jobId = /job-[0-9a-f]{8}/.exec(input.prompt)?.[0] ?? '';
    launches += 1;
    const { token } = claimJob(store, jobId, { session: RUNNER_SESSION });
    const c: Ctx = {
      id: jobId,
      token,
      dir: jobArtifactDir(jobId, store.paths),
      wt: getJob(store.db, jobId).worktreePath ?? '',
    };
    toCi(store, c);
    checks(head(c.wt), [run('test', null, 'queued')]);
    releaseJob(store, jobId, { token });
    left = getJob(store.db, jobId);
    after();
    return {
      pid: 2 ** 31 - 1,
      startedAt: new Date().toISOString(),
      done: Promise.resolve({ code: 0, signal: null, error: null }),
      kill: () => undefined,
    };
  };
  const s = await startSession(
    store,
    { mode: 'ticket', ticket: id },
    { launch, sleep: () => Promise.resolve(), ciMaxPolls },
  );
  const [job, ...others] = ticketJobs(store.db, id);
  if (job === undefined || left === undefined) throw new Error('no job was run');
  expect(others).toHaveLength(0);
  expect(launches).toBe(1);
  const events = listEvents(store.db, job.id, 1000);
  return {
    result: s.tickets[0],
    job,
    left,
    stops: events.filter((e) => e.type === 'runner.stopped'),
    observed: events.filter((e) => e.type === 'ci.observed').length,
    ticket: showTicket(store, id).ticket.status,
  };
}

describe('controller: giving up in the ci stage', () => {
  it('CI still pending after every observation: recorded, released, nothing merged', async () => {
    const r = await stopAtCi(undefined, BUDGET);

    expect(r.result).toMatchObject({ outcome: 'blocked', jobId: r.job.id });
    expect(r.result?.reason).toContain(`still pending after ${String(BUDGET)}`);
    expect(r.stops.map((e) => [e.actor, e.payload])).toEqual([
      [
        RUNNER_SESSION,
        {
          outcome: 'blocked',
          code: 'ci-pending',
          reason: r.result?.reason,
          stage: 'ci',
          status: r.left.status,
          next: r.result?.next,
        },
      ],
    ]);
    expect(r.observed).toBeGreaterThanOrEqual(BUDGET);
    expect(kept(r.job)).toEqual(kept(r.left));
    expect(r.job).toMatchObject({ stage: 'ci', ownerSession: null, ownerToken: null });
    expect(r.ticket).toBe('in-progress');
    expect(ghCalls('merge')).toHaveLength(0);
  });

  it('GitHub unreadable every time: recorded, released, nothing merged', async () => {
    const r = await stopAtCi(() => {
      shim.write({ fail: 'pr view' });
    });

    expect(r.result).toMatchObject({ outcome: 'blocked', jobId: r.job.id });
    expect(r.result?.reason).toContain(`${String(TRANSIENT_ATTEMPTS)} times in a row`);
    expect(r.stops.map((e) => e.payload)).toMatchObject([
      { outcome: 'blocked', code: 'github-unreadable', reason: r.result?.reason, stage: 'ci' },
    ]);
    expect(ghCalls('view').length).toBeGreaterThanOrEqual(TRANSIENT_ATTEMPTS);
    expect(kept(r.job)).toEqual(kept(r.left));
    expect(r.job).toMatchObject({ stage: 'ci', ownerSession: null, ownerToken: null });
    expect(r.ticket).toBe('in-progress');
    expect(ghCalls('merge')).toHaveLength(0);
  });

  it('GitHub failing transiently every time: backs off on the schedule, then unreadable', async () => {
    const r = await stopAtCi(() => {
      shim.write({ fail: 'pr view', failMessage: 'HTTP 502: Bad Gateway' });
    });

    const attempts = GITHUB_BACKOFF_SECONDS.length + 1;
    expect(r.result?.reason).toContain(`${String(attempts)} times in a row`);
    expect(r.stops.map((e) => e.payload)).toMatchObject([
      { outcome: 'blocked', code: 'github-unreadable', reason: r.result?.reason, stage: 'ci' },
    ]);
    expect(ghCalls('view').length).toBeGreaterThanOrEqual(attempts);
    expect(ghCalls('merge')).toHaveLength(0);
  });
});
