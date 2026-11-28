/**
 * The second and last automatic re-run of a head (ticket 0228): after the base stopped failing a
 * shared check the branch contains, and for a check that again did not reach a verdict.
 */
import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/storage/events.ts';
import { type Ctx, head, start, toCi } from './drive.ts';
import { SHIM_BASE_SHA } from './helpers.ts';
import { store, clone, shim, run, checks, reconcile, job, workflowRun } from './ci-fixture.ts';

const BASE = SHIM_BASE_SHA;
const reruns = (c: Ctx) =>
  listEvents(store.db, c.id, 1000)
    .filter((e) => e.type === 'ci.rerun')
    .map((e) => e.payload['attempt']);

describe('ci stage: at most two re-runs per head', () => {
  it('after the base was red and is green again, a contained head is re-run once more, then reworks', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const f1 = run('test', 'failure');
    workflowRun(f1, 7);
    checks(sha, [f1]);
    expect(reconcile(c)).toMatchObject({ action: 'wait', reruns: 1 });
    const f2 = run('test', 'failure');
    workflowRun(f2, 7);
    checks(sha, [f2]);
    checks(BASE, [run('test', 'failure')]);
    expect(reconcile(c).outcome).toBe('base-failing');
    checks(BASE, [run('test', 'success')]);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'pending', action: 'wait', reruns: 2 });
    expect(r.reason).toContain('re-run 2 of 2');
    expect(reruns(c)).toEqual([1, 2]);
    // No third re-run: the next failure of this head is a defect.
    const f3 = run('test', 'failure');
    workflowRun(f3, 7);
    checks(sha, [f3]);
    expect(reconcile(c)).toMatchObject({ outcome: 'failing', action: 'rework', reruns: 2 });
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 1 });
    expect(reruns(c)).toEqual([1, 2]);
  });

  it('a culprit that cannot be re-run takes the usual path once the base is green', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const jenkins = (state: string) => [{ context: 'jenkins', state }];
    shim.write({ statuses: { [sha]: jenkins('failure'), [BASE]: jenkins('failure') } });
    expect(reconcile(c)).toMatchObject({ outcome: 'base-failing', action: 'wait', reruns: 0 });
    shim.write({ statuses: { [sha]: jenkins('failure'), [BASE]: jenkins('success') } });
    expect(reconcile(c)).toMatchObject({ outcome: 'failing', action: 'rework', reruns: 0 });
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 1 });
    expect(reruns(c)).toEqual([]);
  });

  it('a check that again reaches no verdict is re-run a second time; only a third escalates for a CI fix', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    for (const attempt of [1, 2]) {
      const x = run('test', 'cancelled');
      workflowRun(x, 7);
      checks(sha, [x]);
      expect(reconcile(c)).toMatchObject({ outcome: 'pending', action: 'wait', reruns: attempt });
    }
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running' });
    const x = run('test', 'cancelled');
    workflowRun(x, 7);
    checks(sha, [x]);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'infrastructure', action: 'escalate', reruns: 2 });
    expect(r.reason).toContain('(after 2 re-runs)');
    expect(r.reason).toContain('a human fixes CI, then resumes --to ci');
    expect(r.reason).not.toMatch(/re-runs? the workflow/);
    expect(job(c)).toMatchObject({ stage: 'needs-human', ciRepairs: 0 });
    expect(reruns(c)).toEqual([1, 2]);
  });
});
