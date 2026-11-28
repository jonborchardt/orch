/**
 * The controller and a CI failure the base shares (ticket 0228): `pollCi` gives the ticket up at
 * once as `base-failing` with the job released in ci, the queue runs the next ticket, and takes
 * the first again once that one ended done. Real jobs on tests/ci-fixture.ts.
 */
import { describe, expect, it } from 'vitest';

import { endsRun } from '../src/core/workflow.ts';
import { jobArtifactDir } from '../src/core/paths.ts';
import type { ClaudeChild, LaunchInput } from '../src/integrations/claude-session.ts';
import { setMergeAuthorization } from '../src/ops/merge.ts';
import { formatSummary, runSubject } from '../src/ops/run-report.ts';
import { RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import { ticketJobs } from '../src/storage/tickets.ts';
import { checks, clone, reconcile, run, store, workflowRun } from './ci-fixture.ts';
import { type Ctx, head, toCi } from './drive.ts';
import { SHIM_BASE_SHA } from './helpers.ts';

describe('controller: the base fails the same check', () => {
  it('passes the ticket over without waiting, then takes it again after another ticket is done', async () => {
    setMergeAuthorization(store, clone, true);
    const a = addTicket(store, { title: 'Shares a red base', repo: clone, priority: 'P1' }).id;
    const b = addTicket(store, { title: 'Plain', repo: clone, priority: 'P2' }).id;
    const jobOf = (t: number) => ticketJobs(store.db, t)[0]?.id ?? '';
    const shaOf: Record<string, string> = {};
    const launches: string[] = [];
    let atB: { stage: string; status: string; owner: string | null; reads: string[] } | null = null;
    const launch = (input: LaunchInput): ClaudeChild => {
      const jobId = /job-[0-9a-f]{8}/.exec(input.prompt)?.[0] ?? '';
      launches.push(jobId);
      const { token } = claimJob(store, jobId, { session: RUNNER_SESSION });
      const c: Ctx = {
        id: jobId,
        token,
        dir: jobArtifactDir(jobId, store.paths),
        wt: getJob(store.db, jobId).worktreePath ?? '',
      };
      toCi(store, c);
      const sha = head(c.wt);
      shaOf[jobId] = sha;
      if (jobId === jobOf(a)) {
        // The session's first read re-runs the failure; the attempt fails again, as on the base.
        const f1 = run('test', 'failure');
        workflowRun(f1, 7);
        checks(sha, [f1]);
        expect(reconcile(c).reruns).toBe(1);
        checks(sha, [run('test', 'failure')]);
        checks(SHIM_BASE_SHA, [run('test', 'failure')]);
      } else {
        // Ticket A was given up and released while still in ci after one controller read (the
        // session's own read re-ran the check).
        const ja = getJob(store.db, jobOf(a));
        atB = {
          stage: ja.stage,
          status: ja.status,
          owner: ja.ownerSession,
          reads: listEvents(store.db, ja.id, 1000).flatMap((e) =>
            e.type === 'ci.observed' && e.payload['outcome'] !== undefined
              ? [e.payload['outcome'] as string]
              : [],
          ),
        };
        checks(sha, [run('test', 'success')]);
        // The base is fixed meanwhile and A's checks pass on its next read.
        checks(SHIM_BASE_SHA, [run('test', 'success')]);
        checks(shaOf[jobOf(a)] ?? '', [run('test', 'success')]);
      }
      releaseJob(store, jobId, { token });
      return {
        pid: 2 ** 31 - 1,
        startedAt: new Date().toISOString(),
        done: Promise.resolve({ code: 0, signal: null, error: null }),
        kill: () => undefined,
      };
    };

    const s = await startSession(
      store,
      { mode: 'queue', repo: null },
      { launch, sleep: () => Promise.resolve(), pollMs: 1 },
    );

    expect(launches).toEqual([jobOf(a), jobOf(b)]);
    expect(atB).toEqual({
      stage: 'ci',
      status: 'running',
      owner: null,
      reads: ['pending', 'base-failing'],
    });
    const stopped = listEvents(store.db, jobOf(a), 1000).filter((e) => e.type === 'runner.stopped');
    expect(stopped.map((e) => e.payload['code'])).toEqual(['base-failing']);
    expect(stopped[0]?.payload).toMatchObject({ outcome: 'blocked', stage: 'ci' });
    expect(endsRun('base-failing')).toBe(false);
    // Taken again after B was done, and finished by the controller's own read.
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [b, 'done'],
      [a, 'done'],
    ]);
    expect(showTicket(store, a).ticket.status).toBe('done');
    expect(getJob(store.db, jobOf(a))).toMatchObject({ stage: 'completed', ciRepairs: 0 });
    expect(formatSummary(s)).toContain('Needs you (0)');
    expect(runSubject(s)).toContain('0 need you');
  });
});
