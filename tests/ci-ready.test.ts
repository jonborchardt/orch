/**
 * A passing `orch gh ci` completes the job and then marks the draft PR ready; nothing else does.
 */
import { describe, expect, it } from 'vitest';
import { CI_GRACE_POLLS } from '../src/core/ci.ts';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { listEvents } from '../src/storage/events.ts';
import { type Ctx, head, SESSION, start, toCi } from './drive.ts';
import { store, clone, shim, run, checks, reconcile, job, ghCalls } from './ci-fixture.ts';

const readyEvents = (c: Ctx) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type === 'pr.ready');
const isDraft = () => (shim.read().prs[0] as { isDraft: boolean }).isDraft;

describe('ci stage: orch marks a passing PR ready', () => {
  it('a passing verdict completes the job, then takes the draft out of draft', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    checks(sha, [run('test', 'success')]);
    expect(isDraft()).toBe(true);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'passing', action: 'complete', ready: 'marked' });
    expect(JSON.parse(JSON.stringify(r))).toMatchObject({ ready: 'marked', readyError: null });
    expect(ghCalls('ready')).toEqual([['pr', 'ready', 'https://github.com/acme/alpha/pull/1']]);
    expect(isDraft()).toBe(false);
    expect(job(c)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ciStatus: 'passing',
      ciHead: sha,
      prState: 'ready',
      archivedAt: null,
      // The lease was held through the ready write, which released it.
      ownerSession: null,
      ownerToken: null,
      leaseExpiresAt: null,
    });
    expect(readyEvents(c).map((e) => e.payload)).toEqual([{ head: sha, ok: true, error: null }]);
    expect(readyEvents(c)[0]?.actor).toBe(SESSION);
    expect(planJob(store, c.id).reason).toContain('orch marked the PR ready for review');
    expect(planJob(store, c.id).reason).toContain('merging is mergeJob alone');
    expect(planJob(store, c.id).reason).toContain('PR phase ready-to-merge');
    expect(planJob(store, c.id).reason).toContain('Merge on the dashboard');
    // Nothing merged.
    expect(shim.read().calls.some((x) => x[1] === 'merge')).toBe(false);
  });

  it('a failed gh pr ready keeps the verdict, records the error, and exits normally', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    checks(sha, [run('test', 'success')]);
    shim.write({ fail: 'pr ready' });
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'passing', action: 'complete', ready: 'failed' });
    expect(r.readyError).toContain('simulated failure');
    expect(job(c)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ciStatus: 'passing',
      ciHead: sha,
      prState: 'draft',
      archivedAt: null,
      ownerToken: null,
    });
    expect(readyEvents(c).map((e) => e.payload)).toEqual([
      { head: sha, ok: false, error: 'shim: simulated failure' },
    ]);
    expect(isDraft()).toBe(true);
    expect(planJob(store, c.id).reason).toContain('could not mark the PR ready');
  });

  it('an already ready PR is not marked again', () => {
    const c = start(store, clone);
    toCi(store, c);
    const st = shim.read();
    st.prs[0] = { ...st.prs[0], isDraft: false };
    shim.write({ prs: st.prs });
    checks('*', [run('test', 'success')]);
    expect(reconcile(c)).toMatchObject({ action: 'complete', ready: 'already' });
    expect(ghCalls('ready')).toHaveLength(0);
    expect(readyEvents(c)).toHaveLength(0);
    expect(job(c).prState).toBe('ready');
    // No ready write follows, so the completing write itself released the job.
    expect(job(c).ownerToken).toBeNull();
  });

  it('wait, rework, escalate, and a human close-out never call gh pr ready', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    checks(sha, [run('test', null, 'queued')]);
    expect(reconcile(c)).toMatchObject({ action: 'wait', ready: null });
    // GitHub does not name the failed check's workflow run, so no re-run: the failure is a defect.
    checks(sha, [run('test', 'failure')]);
    expect(reconcile(c)).toMatchObject({ action: 'rework', ready: null });

    const d = start(store, clone);
    toCi(store, d);
    checks('*', []);
    for (let i = 1; i < CI_GRACE_POLLS; i++) reconcile(d);
    expect(reconcile(d)).toMatchObject({ action: 'escalate', ready: null });
    resumeFactoryJob(store, d.id, { session: 'human-decided', to: 'completed', force: true });
    expect(job(d)).toMatchObject({ stage: 'completed', prState: 'draft', ownerToken: null });

    expect(ghCalls('ready')).toHaveLength(0);
    expect(readyEvents(c)).toHaveLength(0);
    expect(readyEvents(d)).toHaveLength(0);
  });
});
