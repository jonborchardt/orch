/**
 * GitHub answers that are not verdicts (API failures, missing or skipped checks, closed or moved
 * PRs) are escalated or waited on, never treated as success.
 */
import { describe, expect, it } from 'vitest';
import { CI_GRACE_POLLS } from '../src/core/ci.ts';
import { ToolError } from '../src/core/errors.ts';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { prStatus } from '../src/ops/github.ts';
import { listEvents } from '../src/storage/events.ts';
import { transitionJob } from '../src/storage/jobs.ts';
import { go, head, start, toCi } from './drive.ts';
import { gitIn } from './helpers.ts';
import { store, clone, bare, shim, run, checks, reconcile, job, observed } from './ci-fixture.ts';

describe('ci stage: GitHub answers that are not verdicts', () => {
  it('a green rollup at PR creation or from pr status is not a verdict; only orch gh ci is', () => {
    // Phase 1 validation (A06, issue I-06): `gh pr view` reports a rollup for whatever the head is,
    // and a skipped-only rollup reads as passing. Before the fix, `pr create` stored it with the head
    // and the ci plan went straight to `complete` without `orch gh ci` ever evaluating the commit.
    shim.write({ checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SKIPPED' }] });
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    expect(job(c)).toMatchObject({
      stage: 'ci',
      status: 'running',
      ciStatus: 'passing',
      ciHead: null,
    });
    const plan = planJob(store, c.id);
    expect(plan.commands).toEqual([
      `orch gh ci ${c.id} --token <token>`,
      `orch factory next ${c.id}`,
    ]);
    expect(plan.ci).toMatchObject({ head: null, current: false, polls: 0 });
    expect(() => go(store, c, 'complete')).toThrow(/completed by orch gh ci/);

    // The per-commit read sees the skipped-only run for what it is: nothing verified yet.
    checks(sha, [run('test', 'skipped')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'pending', action: 'wait', head: sha });
    expect(job(c)).toMatchObject({ ciStatus: 'pending', ciHead: sha });

    // A `pr status --token` rollup in between reports the same green rollup and drops the head:
    // still informational, still not a verdict.
    prStatus(store, c.id, { token: c.token });
    expect(job(c)).toMatchObject({ stage: 'ci', ciStatus: 'passing', ciHead: null });
    expect(planJob(store, c.id).commands[0]).toBe(`orch gh ci ${c.id} --token <token>`);
    expect(() => go(store, c, 'complete')).toThrow(/completed by orch gh ci/);
    expect(() => transitionJob(store, c.id, 'complete', { token: c.token })).toThrow(
      /no CI verdict has been read/,
    );

    // Only a real per-commit verdict completes.
    checks(sha, [run('test', 'success')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'passing', action: 'complete', head: sha });
    expect(job(c)).toMatchObject({ stage: 'completed', ciStatus: 'passing', ciHead: sha });
  });

  it('an API or network failure changes nothing and is never a success', () => {
    const c = start(store, clone);
    toCi(store, c);
    const before = job(c);
    shim.write({ fail: 'api repos/' });
    expect(() => reconcile(c)).toThrow(ToolError);
    shim.write({ fail: 'pr view' });
    expect(() => reconcile(c)).toThrow(/simulated failure/);
    shim.write({ fail: undefined });
    const after = job(c);
    expect([after.stage, after.status, after.ciStatus, after.ciHead, after.revision]).toEqual([
      'ci',
      'running',
      before.ciStatus,
      before.ciHead,
      before.revision,
    ]);
    expect(observed(c).filter((e) => e.payload['outcome'] !== undefined)).toHaveLength(0);
    // No per-commit verdict was ever read, so the gate refuses before the pure transition does.
    expect(() => go(store, c, 'complete')).toThrow(/completed by orch gh ci/);
  });

  it('a required check that never reports waits through the grace window, then escalates', () => {
    const c = start(store, clone);
    toCi(store, c);
    shim.write({ protection: { contexts: ['build', 'test'] } });
    checks('*', [run('build', 'success')]);
    for (let i = 1; i < CI_GRACE_POLLS; i++) {
      const r = reconcile(c);
      expect(r).toMatchObject({ outcome: 'pending', action: 'wait', polls: i });
      expect(r.evaluation.missing).toEqual(['test']);
      expect(r.evaluation.configured).toBe(true);
    }
    const r = reconcile(c);
    expect(r).toMatchObject({
      outcome: 'infrastructure',
      action: 'escalate',
      polls: CI_GRACE_POLLS,
    });
    expect(r.reason).toContain('never reported: test');
    expect(job(c)).toMatchObject({ stage: 'needs-human', ciRepairs: 0 });
  });

  it('optional checks may fail when the configured required ones pass (protection or rulesets)', () => {
    const c = start(store, clone);
    toCi(store, c);
    checks('*', [
      run('test', 'success'),
      run('coverage-comment', 'failure'),
      run('lint', 'cancelled'),
    ]);
    shim.write({ protection: { checks: [{ context: 'test' }] } });
    const r1 = reconcile(c);
    expect(r1).toMatchObject({ outcome: 'passing', action: 'complete' });
    expect(r1.evaluation.optionalFailed).toEqual(['coverage-comment', 'lint']);
    expect(job(c).stage).toBe('completed');
    // Rulesets are honoured too.
    shim.write({
      protection: null,
      rules: [
        { type: 'deletion' },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'test' }] },
        },
      ],
    });
    const d = start(store, clone);
    toCi(store, d);
    expect(reconcile(d)).toMatchObject({ outcome: 'passing', action: 'complete' });
    // Without any configuration every check counts.
    shim.write({ rules: [] });
    const e = start(store, clone);
    toCi(store, e);
    expect(reconcile(e)).toMatchObject({ outcome: 'failing', action: 'rework' });
  });

  it('a PR with no checks at all escalates; a human may then close it out, but never a failing one', () => {
    const c = start(store, clone);
    toCi(store, c);
    for (let i = 1; i < CI_GRACE_POLLS; i++) expect(reconcile(c).outcome).toBe('pending');
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'none', action: 'escalate', ciStatus: 'none' });
    expect(r.reason).toContain('resume --to completed');
    expect(job(c)).toMatchObject({ stage: 'needs-human', returnStage: 'ci' });
    const done = resumeFactoryJob(store, c.id, {
      session: 'human-decided',
      to: 'completed',
      force: true,
    });
    expect([done.job.stage, done.job.status]).toEqual(['completed', 'completed']);
    expect(done.plan.step).toBe('done');
    const completed = listEvents(store.db, c.id, 1000).find((e) => e.type === 'job.completed');
    expect(completed?.payload).toMatchObject({ acceptedByHuman: true, ciStatus: 'none' });

    // Failing CI has no such shortcut.
    const d = start(store, clone);
    toCi(store, d);
    checks('*', [run('test', 'cancelled')]);
    expect(reconcile(d).action).toBe('escalate');
    expect(() =>
      resumeFactoryJob(store, d.id, { session: 'human-decided', to: 'completed', force: true }),
    ).toThrow(/required checks are failing/);
    expect(job(d).stage).toBe('needs-human');
  });

  it('a closed PR is escalated and the job keeps its branch', () => {
    const c = start(store, clone);
    toCi(store, c);
    const st = shim.read();
    st.prs[0] = { ...st.prs[0], state: 'CLOSED' };
    shim.write({ prs: st.prs });
    expect(reconcile(c)).toMatchObject({ outcome: 'closed', action: 'escalate' });
    expect(job(c)).toMatchObject({ stage: 'needs-human', prState: 'closed' });
    expect(gitIn(bare, 'rev-parse', `refs/heads/${job(c).branch ?? ''}`)).toBe(head(c.wt));
    // A closed PR is not a delivery a human can accept, whatever its checks said.
    expect(() =>
      resumeFactoryJob(store, c.id, { session: 'human-decided', to: 'completed', force: true }),
    ).toThrow(/closed without merging/);
    // Reopened on GitHub: the next observation records it as a draft again and CI proceeds.
    st.prs[0] = { ...st.prs[0], state: 'OPEN' };
    shim.write({ prs: st.prs });
    checks('*', [run('test', 'success')]);
    const h = resumeFactoryJob(store, c.id, {
      session: 'claude-later-bbbb',
      to: 'ci',
      force: true,
    });
    const c2 = { ...c, token: h.token };
    go(store, c2, 'start');
    expect(reconcile(c2)).toMatchObject({ outcome: 'passing', action: 'complete' });
    expect(job(c2)).toMatchObject({ stage: 'completed', prState: 'ready' });
  });
});
