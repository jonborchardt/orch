/**
 * One bounded re-run per head before a failing check is treated as a defect.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_GRACE_POLLS } from '../src/core/ci.ts';
import { resumeFactoryJob } from '../src/ops/factory.ts';
import { listEvents } from '../src/storage/events.ts';
import { type Ctx, go, head, start, toCi } from './drive.ts';
import { type ShimCheckRun } from './helpers.ts';
import { store, clone, shim, run, checks, reconcile, job, repair } from './ci-fixture.ts';

describe('ci stage: one bounded re-run before a repair', () => {
  /** GitHub knows which workflow run an Actions job belongs to. */
  function workflowRun(check: ShimCheckRun, runId: number): void {
    shim.write({
      api: {
        ...shim.read().api,
        [`repos/acme/alpha/actions/jobs/${String(check.id)}`]: { run_id: runId },
      },
    });
  }
  const rerunCalls = () => shim.read().calls.filter((x) => x[0] === 'run' && x[1] === 'rerun');
  const rerunEvents = (c: Ctx) =>
    listEvents(store.db, c.id, 1000).filter((e) => e.type === 'ci.rerun');

  it('a first failure is re-run once per head; the new attempt decides, and no repair is spent', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const lint = run('lint', 'success');
    const failed = run('test', 'failure');
    workflowRun(failed, 7);
    checks(sha, [lint, failed]);
    const r1 = reconcile(c);
    expect(r1).toMatchObject({
      outcome: 'pending',
      action: 'wait',
      ciStatus: 'pending',
      reruns: 1,
      waitSeconds: 60,
    });
    expect(r1.reason).toContain('re-run 1 of 1 requested for workflow run(s) 7');
    expect(rerunCalls()).toEqual([['run', 'rerun', '7', '--failed', '--repo', 'acme/alpha']]);
    expect(job(c)).toMatchObject({
      stage: 'ci',
      status: 'running',
      ciRepairs: 0,
      ciStatus: 'pending',
    });
    expect(rerunEvents(c).map((e) => e.payload)).toEqual([
      {
        head: sha,
        attempt: 1,
        runs: [7],
        checks: ['test'],
        checkRunIds: [failed.id],
        ok: true,
        error: null,
      },
    ]);
    // No logs are collected for a verdict that may still change.
    expect(existsSync(join(c.dir, 'ci'))).toBe(false);
    // GitHub has not created the new attempt yet: the replaced run is still reported, and ignored.
    const r2 = reconcile(c);
    expect(r2).toMatchObject({ outcome: 'pending', action: 'wait', reruns: 1 });
    expect(r2.reason).toContain('has not reported the new attempt yet');
    // The new attempt appears under a new check-run id, queued, then passes.
    const again = run('test', null, 'queued');
    checks(sha, [lint, again]);
    expect(reconcile(c)).toMatchObject({ outcome: 'pending', action: 'wait', waitSeconds: 60 });
    checks(sha, [lint, { ...again, status: 'completed', conclusion: 'success' }]);
    expect(reconcile(c)).toMatchObject({ outcome: 'passing', action: 'complete', reruns: 1 });
    expect(job(c)).toMatchObject({ stage: 'completed', ciStatus: 'passing', ciHead: sha });
    expect(job(c).ciRepairs).toBe(0);
    expect(rerunCalls()).toHaveLength(1);
    // Nothing merged and nothing pushed by the re-run; only the completion marked the PR ready.
    expect(shim.read().calls.some((x) => x[1] === 'merge')).toBe(false);
    expect(shim.read().calls.filter((x) => x[1] === 'ready')).toHaveLength(1);
  });

  it('when GitHub still lists the replaced attempt next to the new one, the new one decides', () => {
    const suite = { id: 500 };
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const lint = { ...run('lint', 'success'), check_suite: suite };
    const failed = { ...run('test', 'failure'), check_suite: suite };
    workflowRun(failed, 7);
    checks(sha, [lint, failed]);
    expect(reconcile(c)).toMatchObject({ action: 'wait', reruns: 1 });
    // The old attempt stays on the first page; the new one (same suite, newer id) is on the second.
    const filler = Array.from({ length: 98 }, (_, i) => run(`matrix-${String(i)}`, 'success'));
    const again = { ...run('test', 'success'), check_suite: suite };
    checks(sha, [lint, failed, ...filler, again]);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'passing', action: 'complete', reruns: 1 });
    expect(r.evaluation.required).toHaveLength(100);
    expect(job(c)).toMatchObject({ ciStatus: 'passing', ciHead: sha, ciRepairs: 0 });
    expect(rerunCalls()).toHaveLength(1);

    // The inverse: the new attempt fails too. The second verdict is the current attempt's, and
    // its log (not the replaced run's) is what the builder gets.
    const d = start(store, clone);
    toCi(store, d);
    const shaD = head(d.wt);
    const first = { ...run('test', 'failure'), check_suite: suite };
    workflowRun(first, 8);
    checks(shaD, [first]);
    expect(reconcile(d)).toMatchObject({ action: 'wait', reruns: 1 });
    const second = { ...run('test', 'failure'), check_suite: suite };
    shim.write({ logs: { [String(second.id)]: 'npm test\nFAIL second attempt\n' } });
    checks(shaD, [first, second]);
    const rd = reconcile(d);
    expect(rd).toMatchObject({ outcome: 'failing', action: 'rework', reruns: 1 });
    expect(rd.evaluation.failed.map((x) => x.id)).toEqual([second.id]);
    expect(rd.failures[0]?.log).toBe(`ci/${shaD.slice(0, 7)}/test.log`);
    expect(readFileSync(join(d.dir, rd.failures[0]?.log ?? ''), 'utf8')).toContain(
      'second attempt',
    );
    expect(job(d)).toMatchObject({ stage: 'build', ciRepairs: 1 });
  });

  it('a second failure of the same commit is a defect: logs, rework, no further re-run', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const failed = run('test', 'failure');
    workflowRun(failed, 7);
    checks(sha, [failed]);
    expect(reconcile(c).action).toBe('wait');
    const again = run('test', 'failure');
    shim.write({ logs: { [String(again.id)]: 'npm test\nFAIL again\n' } });
    checks(sha, [again]);
    const r = reconcile(c);
    expect(r).toMatchObject({
      outcome: 'failing',
      action: 'rework',
      ciStatus: 'failing',
      reruns: 1,
    });
    expect(r.reason).toContain('(after 1 re-run)');
    expect(r.failures[0]?.log).toBe(`ci/${sha.slice(0, 7)}/test.log`);
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 1 });
    expect(rerunCalls()).toHaveLength(1);
    // The repaired commit is another head with its own single re-run; the first head's does not carry over.
    const sha2 = repair(c, 'src/fix.ts');
    const f2 = run('test', 'failure');
    workflowRun(f2, 8);
    checks(sha2, [f2]);
    expect(reconcile(c)).toMatchObject({ head: sha2, action: 'wait', reruns: 1 });
    expect(rerunCalls().map((x) => x[2])).toEqual(['7', '8']);
    checks(sha2, [run('test', 'failure')]);
    expect(reconcile(c)).toMatchObject({ head: sha2, action: 'rework', reruns: 1 });
    expect(job(c).ciRepairs).toBe(2);
  });

  it('waits for the other required checks to finish first: a running workflow cannot be re-run', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const failed = run('test', 'failure');
    workflowRun(failed, 7);
    const building = run('build', null, 'in_progress');
    checks(sha, [failed, building]);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'pending', action: 'wait', reruns: 0 });
    expect(r.reason).toContain('waiting for build to finish before re-running');
    expect(rerunCalls()).toHaveLength(0);
    checks(sha, [failed, { ...building, status: 'completed', conclusion: 'success' }]);
    expect(reconcile(c)).toMatchObject({ action: 'wait', reruns: 1 });
    expect(rerunCalls()).toHaveLength(1);
  });

  it('cancelled and timed-out checks are re-run too; a repeat still escalates or reworks as before', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const cancelled = run('test', 'cancelled');
    workflowRun(cancelled, 7);
    checks(sha, [cancelled]);
    expect(reconcile(c)).toMatchObject({ outcome: 'pending', action: 'wait', reruns: 1 });
    checks(sha, [run('test', 'cancelled')]);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'infrastructure', action: 'escalate', reruns: 1 });
    expect(r.reason).toContain('(after 1 re-run)');
    expect(job(c)).toMatchObject({ stage: 'needs-human', ciRepairs: 0 });

    const d = start(store, clone);
    toCi(store, d);
    const shaD = head(d.wt);
    const slow = run('test', 'timed_out');
    workflowRun(slow, 9);
    checks(shaD, [slow]);
    expect(reconcile(d)).toMatchObject({ action: 'wait', reruns: 1 });
    checks(shaD, [run('test', 'timed_out')]);
    expect(reconcile(d)).toMatchObject({ action: 'rework', reruns: 1 });
    expect(job(d).ciRepairs).toBe(1);
  });

  it('when GitHub refuses the re-run or cannot name the run, the verdict stands and the attempt is recorded', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const failed = run('test', 'failure');
    workflowRun(failed, 7);
    checks(sha, [failed]);
    shim.write({ fail: 'run rerun' });
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'failing', action: 'rework', reruns: 0 });
    expect(r.reason).toContain('Re-run could not be requested: gh run rerun 7 failed');
    expect(rerunEvents(c).map((e) => [e.payload['ok'], e.payload['head']])).toEqual([[false, sha]]);
    expect(job(c).ciRepairs).toBe(1);
    shim.write({ fail: undefined });

    // GitHub does not know the job's workflow run (HTTP 404): nothing to re-run.
    const d = start(store, clone);
    toCi(store, d);
    checks(head(d.wt), [run('test', 'failure')]);
    const rd = reconcile(d);
    expect(rd).toMatchObject({ action: 'rework', reruns: 0 });
    expect(rd.reason).toContain('did not report the workflow run of check test');

    // A commit status from another CI system is never re-run, and a required check that never
    // reported has nothing to re-run.
    const e = start(store, clone);
    toCi(store, e);
    shim.write({ statuses: { [head(e.wt)]: [{ context: 'jenkins', state: 'failure' }] } });
    expect(reconcile(e)).toMatchObject({ outcome: 'failing', action: 'rework', reruns: 0 });
    expect(rerunCalls()).toHaveLength(1); // only the refused attempt above
  });

  it('the replaced verdict is ignored for the grace window only, and a resumed session keeps the budget', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const failed = run('test', 'failure');
    workflowRun(failed, 7);
    checks(sha, [failed]);
    expect(reconcile(c)).toMatchObject({ action: 'wait', reruns: 1 });
    // The session dies; another resumes and keeps polling while GitHub still shows the old run.
    const h = resumeFactoryJob(store, c.id, { session: 'claude-later-0002', force: true });
    expect(h.plan.ci).toMatchObject({ reruns: 1, polls: 1, sessionPolls: 0 });
    const c2 = { ...c, token: h.token };
    go(store, c2, 'start');
    // The replaced run is ignored for CI_GRACE_POLLS observations after the re-run (one happened
    // in the first session already).
    for (let i = 1; i < CI_GRACE_POLLS; i++) {
      expect(reconcile(c2)).toMatchObject({ outcome: 'pending', action: 'wait', reruns: 1 });
    }
    expect(reconcile(c2)).toMatchObject({ outcome: 'pending', action: 'wait', reruns: 1 });
    // Past the grace window the old verdict counts and the budget is spent: rework, no new re-run.
    expect(reconcile(c2)).toMatchObject({ outcome: 'failing', action: 'rework', reruns: 1 });
    expect(rerunCalls()).toHaveLength(1);
  });
});
