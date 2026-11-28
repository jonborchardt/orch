/**
 * A failure the base tip shares waits in ci instead of reworking or escalating, and once the base
 * is green the job integrates it (ticket 0228). Second re-runs live in ci-base-rerun.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { waitSeconds } from '../src/core/ci.ts';
import { listEvents } from '../src/storage/events.ts';
import { head, start, toCi } from './drive.ts';
import { SHIM_BASE_SHA } from './helpers.ts';
import {
  store,
  clone,
  shim,
  run,
  checks,
  reconcile,
  job,
  observed,
  eventTypes,
  workflowRun,
} from './ci-fixture.ts';

const BASE = SHIM_BASE_SHA;

describe('ci stage: a failure shared with the base tip', () => {
  it('waits as base-failing, spends nothing, then integrates the green base without a repair', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const failed = run('test', 'failure');
    workflowRun(failed, 7);
    checks(sha, [failed]);
    expect(reconcile(c)).toMatchObject({ action: 'wait', reruns: 1, base: null });
    checks(sha, [run('test', 'failure')]);
    checks(BASE, [run('test', 'failure')]);
    const r = reconcile(c);
    expect(r).toMatchObject({
      outcome: 'base-failing',
      action: 'wait',
      ciStatus: 'failing',
      reruns: 1,
      base: { branch: 'main', sha: BASE, verdict: 'failing' },
    });
    expect(r.reason).toContain('no person is needed');
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running', ciRepairs: 0 });
    expect(eventTypes(c)).not.toContain('job.blocked');
    expect(eventTypes(c)).not.toContain('job.reworked');
    expect(observed(c).at(-1)?.payload).toMatchObject({
      outcome: 'base-failing',
      base: {
        branch: 'main',
        sha: BASE,
        verdict: 'failing',
        checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      },
    });
    // The base tip came from GitHub, and its checks were read for that sha.
    const calls = shim.read().calls;
    expect(calls).toContainEqual(['api', 'repos/acme/alpha/commits/main']);
    expect(calls).toContainEqual([
      'api',
      `repos/acme/alpha/commits/${BASE}/check-runs?per_page=100`,
      '--paginate',
      '--slurp',
    ]);

    // The base turns green; GitHub's compare gives no answer: still waiting for the base.
    checks(BASE, [run('test', 'success')]);
    const compare = `repos/acme/alpha/compare/${BASE}...${sha}`;
    shim.write({ api: { ...shim.read().api, [compare]: {} } });
    expect(reconcile(c)).toMatchObject({ outcome: 'base-failing', action: 'wait' });
    expect(job(c)).toMatchObject({ stage: 'ci', ciRepairs: 0 });

    // The head does not contain the green tip: rework to integrate it, no repair spent.
    shim.write({ api: { ...shim.read().api, [compare]: { behind_by: 2 } } });
    const i = reconcile(c);
    expect(i).toMatchObject({ action: 'rework', reruns: 1 });
    expect(i.reason).toContain(`integrate ${BASE}`);
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 0 });
    const reworked = listEvents(store.db, c.id, 1000).filter((e) => e.type === 'job.reworked');
    expect(reworked.map((e) => e.payload['integration'])).toEqual([true]);
  });

  it('a check cancelled twice waits for the base while the base runs it, then as base-failing', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const first = run('test', 'cancelled');
    workflowRun(first, 7);
    checks(sha, [first]);
    expect(reconcile(c)).toMatchObject({ action: 'wait', reruns: 1 });
    const second = run('test', 'cancelled');
    workflowRun(second, 7);
    checks(sha, [second]);
    checks(BASE, [run('test', null, 'in_progress')]);
    const p = reconcile(c);
    expect(p).toMatchObject({
      outcome: 'pending',
      action: 'wait',
      waitSeconds: waitSeconds(p.polls),
      reruns: 1,
      base: { verdict: 'pending' },
    });
    expect(job(c)).toMatchObject({ stage: 'ci', ciRepairs: 0 });
    checks(BASE, [run('test', 'cancelled')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'base-failing', action: 'wait', reruns: 1 });
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running', ciRepairs: 0 });
    expect(eventTypes(c)).not.toContain('job.blocked');
    expect(eventTypes(c).filter((t) => t === 'ci.rerun')).toHaveLength(1);
  });
});
