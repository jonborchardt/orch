/**
 * The controller and the ci stage, with a real job: the Claude session delivers the PR, sees CI
 * pending, releases the job and exits, as the /factory skill does after its polls. The controller
 * then reads GitHub itself, without a second session, and merges once the checks pass.
 */
import { describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import type { ClaudeChild, LaunchInput } from '../src/integrations/claude-session.ts';
import { setMergeAuthorization } from '../src/ops/merge.ts';
import { RUNNER_SESSION, runnerStatus, startSession } from '../src/ops/run.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import { ticketJobs } from '../src/storage/tickets.ts';
import { checks, clone, ghCalls, reconcile, run, store } from './ci-fixture.ts';
import { type Ctx, head, toCi } from './drive.ts';

describe('controller: pending CI', () => {
  it('waits for the verdict itself, then merges and closes the ticket', async () => {
    setMergeAuthorization(store, clone, true);
    const id = addTicket(store, { title: 'Export CSV', repo: clone }).id;
    const launches: string[] = [];
    let sha = '';
    const launch = (input: LaunchInput): ClaudeChild => {
      const jobId = /job-[0-9a-f]{8}/.exec(input.prompt)?.[0] ?? '';
      launches.push(jobId);
      const job = getJob(store.db, jobId);
      const { token } = claimJob(store, jobId, { session: RUNNER_SESSION });
      const c: Ctx = {
        id: jobId,
        token,
        dir: jobArtifactDir(jobId, store.paths),
        wt: job.worktreePath ?? '',
      };
      toCi(store, c);
      sha = head(c.wt);
      checks(sha, [run('test', null, 'queued')]);
      expect(reconcile(c).action).toBe('wait');
      releaseJob(store, jobId, { token });
      return {
        pid: 2 ** 31 - 1,
        startedAt: new Date().toISOString(),
        done: Promise.resolve({ code: 0, signal: null, error: null }),
        kill: () => undefined,
      };
    };
    // The checks finish while the controller is waiting between two reads.
    let sleeps = 0;
    const sleep = () => {
      sleeps += 1;
      if (sleeps === 1) {
        expect(runnerStatus(store)).toMatchObject({ state: 'running', current: { waiting: 'ci' } });
        checks(sha, [run('test', 'success')]);
      }
      return Promise.resolve();
    };

    const s = await startSession(store, { mode: 'ticket', ticket: id }, { launch, sleep });

    const [job] = ticketJobs(store.db, id);
    expect(launches).toEqual([job?.id]);
    expect(ticketJobs(store.db, id)).toHaveLength(1);
    expect(sleeps).toBeGreaterThan(0);
    expect(job).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ciStatus: 'passing',
      ciHead: sha,
      prState: 'merged',
      ownerSession: null,
    });
    // The controller's reads are ordinary observations under its own session.
    const observed = listEvents(store.db, job?.id ?? '', 1000).filter(
      (e) => e.type === 'ci.observed',
    );
    expect(observed.at(-1)?.actor).toBe(RUNNER_SESSION);
    expect(ghCalls('create')).toHaveLength(1);
    expect(ghCalls('merge')).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({ outcome: 'done', relands: 0 });
    expect(showTicket(store, id).ticket.status).toBe('done');
  });
});
