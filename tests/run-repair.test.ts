/**
 * The controller and a failing CI, with a real job: the first session delivers the PR and exits;
 * the controller reads the failure itself, lets `orch gh ci` spend its one re-run, and on the
 * second failure finds the job back in build. It starts a second session on the same job, which
 * repairs it through the ordinary build, review, approve, and pr gates; the controller then reads
 * the passing verdict for the new head, merges exactly that head, and closes the ticket.
 */
import { describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import type { ClaudeChild, LaunchInput } from '../src/integrations/claude-session.ts';
import { setMergeAuthorization } from '../src/ops/merge.ts';
import { RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import { ticketJobs } from '../src/storage/tickets.ts';
import { checks, clone, ghCalls, repair, run, shim, store } from './ci-fixture.ts';
import { type Ctx, head, toCi } from './drive.ts';
import type { ShimCheckRun } from './helpers.ts';

/** GitHub knows which workflow run an Actions job belongs to, so the check can be re-run. */
function workflowRun(check: ShimCheckRun, runId: number): void {
  shim.write({
    api: {
      ...shim.read().api,
      [`repos/acme/alpha/actions/jobs/${String(check.id)}`]: { run_id: runId },
    },
  });
}
const reruns = () => shim.read().calls.filter((x) => x[0] === 'run' && x[1] === 'rerun');

describe('controller: a CI failure is repaired on the same job and only the new head is merged', () => {
  it('re-runs once, reworks to build, runs a second session, and merges the verified head', async () => {
    setMergeAuthorization(store, clone, true);
    const id = addTicket(store, { title: 'Export CSV', repo: clone }).id;
    const launches: string[] = [];
    let broken = '';
    let fixed = '';
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
      if (launches.length === 1) {
        // The first session delivers the PR and ends; the required check then fails.
        toCi(store, c);
        broken = head(c.wt);
        const failed = run('test', 'failure');
        workflowRun(failed, 7);
        checks(broken, [failed]);
      } else {
        // The second one finds the job in build for a CI repair and takes it through every gate.
        expect(job).toMatchObject({ stage: 'build', ciRepairs: 1 });
        fixed = repair(c, 'src/fix.ts');
        checks(fixed, [run('test', 'success')]);
      }
      releaseJob(store, jobId, { token });
      return {
        pid: 2 ** 31 - 1,
        startedAt: new Date().toISOString(),
        done: Promise.resolve({ code: 0, signal: null, error: null }),
        kill: () => undefined,
      };
    };
    // Once the re-run was requested, GitHub reports the new attempt: the same check fails again.
    let replaced = false;
    const sleep = () => {
      if (!replaced && reruns().length === 1) {
        replaced = true;
        const again = run('test', 'failure');
        workflowRun(again, 7);
        checks(broken, [again]);
      }
      return Promise.resolve();
    };

    const s = await startSession(store, { mode: 'ticket', ticket: id }, { launch, sleep });

    // One job did all of it, on one PR.
    const [job, ...others] = ticketJobs(store.db, id);
    const jobId = job?.id ?? '';
    expect(others).toHaveLength(0);
    expect(launches).toEqual([jobId, jobId]);
    expect(ghCalls('create')).toHaveLength(1);
    expect(fixed).not.toBe(broken);
    expect(job).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ciStatus: 'passing',
      ciHead: fixed,
      ciRepairs: 1,
      maxCiRepairs: 2,
      prState: 'merged',
      ownerSession: null,
    });

    // The evidence of the failure and the repair is the job's own.
    const events = listEvents(store.db, jobId, 1000);
    const of = (type: string) => events.filter((e) => e.type === type);
    expect(reruns()).toHaveLength(1);
    expect(of('ci.rerun').map((e) => e.payload)).toMatchObject([{ head: broken, ok: true }]);
    expect(of('job.reworked').map((e) => e.payload)).toMatchObject([{ from: 'ci', ciRepairs: 1 }]);
    expect(of('job.reworked')[0]?.actor).toBe(RUNNER_SESSION);
    const verdicts = of('ci.observed').map((e) => [e.payload['head'], e.payload['outcome']]);
    expect(verdicts).toContainEqual([broken, 'failing']);
    expect(verdicts.at(-1)).toEqual([fixed, 'passing']);
    expect(of('runner.session').map((e) => e.payload)).toMatchObject([
      { outcome: 'exited', moved: true, stage: 'ci' },
      { outcome: 'exited', moved: true, stage: 'ci' },
    ]);
    expect(of('runner.stopped')).toHaveLength(0);

    // Merged once, at the head CI passed on; the failing head was never offered to GitHub.
    const merged = ghCalls('merge');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toContain(fixed);
    expect(merged.flat()).not.toContain(broken);
    expect(s.tickets[0]).toMatchObject({ outcome: 'done', jobId, relands: 0 });
    expect(showTicket(store, id).ticket.status).toBe('done');
  });
});
