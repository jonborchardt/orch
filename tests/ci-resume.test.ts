/**
 * The ci stage survives interruption and resume: a resumed session reads GitHub afresh and never
 * completes on a verdict recorded before the interruption. Split from ci-repair.test.ts because
 * every scenario here drives its own job from start to ci, and a file's tests run serially.
 */
import { describe, expect, it } from 'vitest';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { recordCi } from '../src/storage/jobs.ts';
import { type Ctx, go, head, start, toCi } from './drive.ts';
import { gitIn } from './helpers.ts';
import { store, clone, shim, run, checks, reconcile, job, ghCalls } from './ci-fixture.ts';

describe('ci stage: interruption and resume', () => {
  it('a session that stops while CI is pending resumes into the same stage and finds it finished', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    checks(sha, [run('test', null, 'queued')]);
    expect(reconcile(c).action).toBe('wait');

    // The CLI exited and the session died; another session adopts the job from persisted state.
    const r = resumeFactoryJob(store, c.id, { session: 'claude-later-0001', force: true });
    expect(r.tookOver).toBe(true);
    expect([r.plan.stage, r.plan.status]).toEqual(['ci', 'pending']);
    expect(r.plan.commands).toEqual([
      `orch job transition ${c.id} start --token <token>`,
      `orch gh ci ${c.id} --token <token>`,
      `orch factory next ${c.id}`,
    ]);
    expect(r.plan.pr.url).toBe('https://github.com/acme/alpha/pull/1');
    const c2 = { ...c, token: r.token };
    // Stale observations are not trusted: the recorded rollup is still pending until re-read.
    go(store, c2, 'start');
    expect(() => go(store, c2, 'complete')).toThrow(/completed by orch gh ci/);
    checks(sha, [run('test', 'success')]);
    const again = reconcile(c2);
    expect(again).toMatchObject({ action: 'complete', head: sha, polls: 2 });
    expect(job(c2).stage).toBe('completed');
    expect(ghCalls('create')).toHaveLength(1);
  });
});

// Phase 1 validation (A06): a resumed session completed on a verdict recorded before the
// interruption. The verdict was genuine, but between the read and the completion the PR head can
// move, the PR can be closed, or a check can be rerun and fail. Plant such a verdict the way the
// old code left it (storage-level, as the orphaned shell did) and show that nothing completes
// without a fresh read that still passes for this head. One job per case, one case per test.
describe('ci stage: a stored passing verdict is confirmed against GitHub at completion, never reused', () => {
  /** A job in ci with a planted passing verdict that the plan and the transition both refuse. */
  const planted = (): Ctx => {
    const c = start(store, clone);
    toCi(store, c);
    recordCi(store, c.id, { token: c.token, ciStatus: 'passing', head: head(c.wt) });
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running', ciStatus: 'passing' });
    // The plan never says `complete`, and the transition refuses it outright.
    const plan = planJob(store, c.id);
    expect(plan.commands).toEqual([
      `orch gh ci ${c.id} --token <token>`,
      `orch factory next ${c.id}`,
    ]);
    expect(plan.reason).toContain('confirmed against GitHub, not reused');
    expect(() => go(store, c, 'complete')).toThrow(/completed by orch gh ci/);
    expect(job(c).stage).toBe('ci');
    return c;
  };

  it('a resumed session reads first; the PR was closed: escalate, not complete', () => {
    const a = planted();
    const r = resumeFactoryJob(store, a.id, { session: 'claude-later-0002', force: true });
    expect(r.plan.commands).toEqual([
      `orch job transition ${a.id} start --token <token>`,
      `orch gh ci ${a.id} --token <token>`,
      `orch factory next ${a.id}`,
    ]);
    const a2 = { ...a, token: r.token };
    go(store, a2, 'start');
    const st = shim.read();
    st.prs[0] = { ...st.prs[0], state: 'CLOSED' };
    shim.write({ prs: st.prs });
    expect(reconcile(a2)).toMatchObject({ outcome: 'closed', action: 'escalate' });
    expect(job(a2).stage).toBe('needs-human');
  });

  it('a check was rerun for the same commit and failed: rework, not complete', () => {
    const b = planted();
    checks(head(b.wt), [run('test', 'failure')]);
    expect(reconcile(b)).toMatchObject({ outcome: 'failing', action: 'rework' });
    expect(job(b).stage).toBe('build');
  });

  it('someone pushed to the PR branch: the head moved, so the verdict is outdated', () => {
    const d = planted();
    const tree = gitIn(d.wt, 'rev-parse', 'HEAD^{tree}');
    const outside = gitIn(d.wt, 'commit-tree', tree, '-p', 'HEAD', '-m', 'pushed from elsewhere');
    gitIn(d.wt, 'push', '-q', 'origin', `${outside}:refs/heads/${job(d).branch ?? ''}`);
    checks('*', [run('test', 'success')]);
    expect(reconcile(d)).toMatchObject({ outcome: 'outdated', action: 'escalate', current: false });
    expect(job(d).stage).toBe('needs-human');
  });

  it('nothing changed: the fresh read passes and completes', () => {
    const e = planted();
    checks(head(e.wt), [run('test', 'success')]);
    expect(reconcile(e)).toMatchObject({ outcome: 'passing', action: 'complete' });
    expect(job(e).stage).toBe('completed');
  });
});
