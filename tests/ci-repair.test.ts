/**
 * The ci stage repairs failing checks through the normal build -> review -> approve -> pr cycle on
 * the same PR, bounds those repairs, and survives interruption, resume, and release.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_MAX_SESSION_POLLS } from '../src/core/ci.ts';
import { OwnershipError } from '../src/core/errors.ts';
import { MAX_CI_REPAIRS_REASON } from '../src/core/workflow.ts';
import { configPath, planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { pushBranch, reconcileCi } from '../src/ops/github.ts';
import { verificationStatus } from '../src/ops/verify.ts';
import { worktreeOf } from '../src/ops/tree.ts';
import { listEvents } from '../src/storage/events.ts';
import { recordCi, releaseJob } from '../src/storage/jobs.ts';
import { add, type Ctx, deliverPr, go, head, passRound, start, toCi, verify } from './drive.ts';
import { commitFile, fixture, gitIn } from './helpers.ts';
import {
  store,
  clone,
  bare,
  shim,
  run,
  checks,
  reconcile,
  job,
  ghCalls,
  repair,
} from './ci-fixture.ts';

describe('ci stage: failing checks and the repair cycle', () => {
  it('saves the failing log, reworks to build, repairs on the same PR, and passes', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha1 = head(c.wt);
    const failed = run('test', 'failure');
    shim.write({
      logs: { [String(failed.id)]: 'npm test\n\nFAIL src/export.test.ts\n  expected 1 to be 2\n' },
    });
    checks(sha1, [run('lint', 'success'), failed]);

    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'failing', action: 'rework', ciStatus: 'failing' });
    expect(r.failures).toEqual([
      {
        name: 'test',
        conclusion: 'failure',
        url: failed.html_url,
        log: `ci/${sha1.slice(0, 7)}/test.log`,
      },
    ]);
    const log = join(c.dir, 'ci', sha1.slice(0, 7), 'test.log');
    expect(readFileSync(log, 'utf8')).toContain('expected 1 to be 2');
    expect(r.reason).toContain('CI failed for');
    expect(r.reason).toContain(`ci/${sha1.slice(0, 7)}/test.log`);
    expect(job(c)).toMatchObject({ stage: 'build', status: 'pending', ciRepairs: 1, ciHead: sha1 });
    const reworked = listEvents(store.db, c.id, 1000).find((e) => e.type === 'job.reworked');
    expect(reworked?.payload).toMatchObject({ from: 'ci', ciRepairs: 1 });

    // The build plan carries the CI context and the log path to the builder.
    const buildPlan = planJob(store, c.id);
    expect(buildPlan.stage).toBe('build');
    expect(buildPlan.reason).toContain('CI repair 1 of 2');
    expect(buildPlan.reason).toContain('test.log');
    expect(buildPlan.commands).toContain(
      `orch job artifact add ${c.id} build.md --replace --token <token>`,
    );

    // The repair commit invalidates the earlier verification run and the approval: nothing can be
    // pushed until the code is verified, reviewed, and approved again.
    go(store, c, 'start');
    const sha2 = commitFile(c.wt, 'src/export.ts', '// fixed\n', 'fix export');
    const tree = worktreeOf(job(c));
    expect(tree && verificationStatus(store, job(c), tree).valid).toBe(false);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(
      /Pushing is allowed in the pr stage/,
    );
    verify(store, c);
    add(store, c, 'build.md', fixture('build.md'), true);
    go(store, c, 'complete');
    expect(job(c).round).toBe(2);
    passRound(store, c);
    // The earlier approval describes the old commit and is not evidence for the repaired one.
    go(store, c, 'start');
    expect(() => go(store, c, 'complete')).toThrow(/decision.md describe/);
    add(store, c, 'decision.md', fixture('decision.md'), true);
    go(store, c, 'complete');
    go(store, c, 'start');
    expect(planJob(store, c.id).reason).toContain('is updated, never duplicated');
    deliverPr(store, c);
    expect(ghCalls('create')).toHaveLength(1);
    expect(shim.read().prs).toHaveLength(1);
    expect(gitIn(bare, 'rev-parse', `refs/heads/${job(c).branch ?? ''}`)).toBe(sha2);
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'pending', ciHead: null });

    go(store, c, 'start');
    checks(sha2, [run('lint', 'success'), run('test', 'success')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'passing', action: 'complete', head: sha2 });
    expect(job(c)).toMatchObject({ stage: 'completed', ciRepairs: 1 });
  });

  it('stops after the configured number of repairs: needs-human, PR and worktree kept', () => {
    writeFileSync(configPath(store), JSON.stringify({ maxCiRepairs: 1 }));
    const c = start(store, clone);
    expect(job(c).maxCiRepairs).toBe(1);
    toCi(store, c);
    checks('*', [run('test', 'failure')]);
    expect(reconcile(c).action).toBe('rework');
    repair(c, 'src/attempt1.ts');
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'failing', action: 'exhausted' });
    expect(job(c)).toMatchObject({
      stage: 'needs-human',
      status: 'blocked',
      returnStage: 'build',
      ciRepairs: 1,
    });
    const plan = planJob(store, c.id);
    expect(plan.step).toBe('needs-human');
    expect(plan.blockedReason).toBe(MAX_CI_REPAIRS_REASON);
    const blocked = listEvents(store.db, c.id, 1000).find((e) => e.type === 'job.blocked');
    expect(blocked?.payload['detail']).toContain('CI failed for');
    expect(existsSync(c.wt)).toBe(true);
    expect(shim.read().prs).toHaveLength(1);
    expect(gitIn(bare, 'rev-parse', `refs/heads/${job(c).branch ?? ''}`)).toBe(head(c.wt));
    // The budget is spent: a human sends it back to build, and the next failure escalates again.
    const h = resumeFactoryJob(store, c.id, { session: 'human-helper', to: 'build', force: true });
    expect(h.plan.stage).toBe('build');
    repair({ ...c, token: h.token }, 'src/attempt2.ts');
    expect(reconcileCi(store, c.id, { token: h.token }).action).toBe('exhausted');
    expect(job(c).stage).toBe('needs-human');
  });

  it('a check that did not run is escalated without spending a repair', () => {
    const c = start(store, clone);
    toCi(store, c);
    checks('*', [run('test', 'cancelled')]);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'infrastructure', action: 'escalate', ciStatus: 'failing' });
    expect(r.reason).toContain('Not a code defect');
    expect(job(c)).toMatchObject({ stage: 'needs-human', returnStage: 'ci', ciRepairs: 0 });
    // The human re-runs the workflow; the session resumes to ci and reads the new verdict.
    checks('*', [run('test', 'success')]);
    const h = resumeFactoryJob(store, c.id, {
      session: 'claude-later-aaaa',
      to: 'ci',
      force: true,
    });
    const c2 = { ...c, token: h.token };
    expect(h.plan.commands[0]).toContain('transition');
    go(store, c2, 'start');
    expect(reconcile(c2).action).toBe('complete');
    expect(job(c2).stage).toBe('completed');
  });
});

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

  it('a stored passing verdict is confirmed against GitHub at completion, never reused', () => {
    // Phase 1 validation (A06): a resumed session completed on a verdict recorded before the
    // interruption. The verdict was genuine, but between the read and the completion the PR head
    // can move, the PR can be closed, or a check can be rerun and fail. Plant such a verdict the
    // way the old code left it (storage-level, as the orphaned shell did) and show that nothing
    // completes without a fresh read that still passes for this head.
    const plant = (c: Ctx) => {
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
    };

    // A resumed session sees the same plan: read first.
    const a = start(store, clone);
    toCi(store, a);
    plant(a);
    const r = resumeFactoryJob(store, a.id, { session: 'claude-later-0002', force: true });
    expect(r.plan.commands).toEqual([
      `orch job transition ${a.id} start --token <token>`,
      `orch gh ci ${a.id} --token <token>`,
      `orch factory next ${a.id}`,
    ]);
    // The PR was closed in the meantime: escalate, not complete.
    const a2 = { ...a, token: r.token };
    go(store, a2, 'start');
    const st = shim.read();
    st.prs[0] = { ...st.prs[0], state: 'CLOSED' };
    shim.write({ prs: st.prs });
    expect(reconcile(a2)).toMatchObject({ outcome: 'closed', action: 'escalate' });
    expect(job(a2).stage).toBe('needs-human');

    // A check was rerun for the same commit and failed: rework, not complete.
    const b = start(store, clone);
    toCi(store, b);
    plant(b);
    checks(head(b.wt), [run('test', 'failure')]);
    expect(reconcile(b)).toMatchObject({ outcome: 'failing', action: 'rework' });
    expect(job(b).stage).toBe('build');

    // Someone pushed to the PR branch: the head moved, so the verdict is outdated.
    const d = start(store, clone);
    toCi(store, d);
    plant(d);
    const tree = gitIn(d.wt, 'rev-parse', 'HEAD^{tree}');
    const outside = gitIn(d.wt, 'commit-tree', tree, '-p', 'HEAD', '-m', 'pushed from elsewhere');
    gitIn(d.wt, 'push', '-q', 'origin', `${outside}:refs/heads/${job(d).branch ?? ''}`);
    checks('*', [run('test', 'success')]);
    expect(reconcile(d)).toMatchObject({ outcome: 'outdated', action: 'escalate', current: false });
    expect(job(d).stage).toBe('needs-human');

    // Nothing changed: the fresh read passes and completes.
    const e = start(store, clone);
    toCi(store, e);
    plant(e);
    checks(head(e.wt), [run('test', 'success')]);
    expect(reconcile(e)).toMatchObject({ outcome: 'passing', action: 'complete' });
    expect(job(e).stage).toBe('completed');
  });
});

describe('ci stage: polling cadence in the plan', () => {
  it('reports the wait, counts observations per session, and asks for a release after the cap', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    checks(sha, [run('test', null, 'queued')]);
    expect(reconcile(c).waitSeconds).toBe(60);
    let plan = planJob(store, c.id);
    expect(plan.ci).toMatchObject({
      polls: 1,
      sessionPolls: 1,
      waitSeconds: 60,
      release: false,
      reruns: 0,
    });
    expect(plan.reason).toContain('sleep plan.ci.waitSeconds (60 s now)');
    // Further pending observations, recorded directly: the schedule is about counts, not clocks.
    for (let i = 2; i <= CI_MAX_SESSION_POLLS; i++) {
      recordCi(store, c.id, {
        token: c.token,
        ciStatus: 'pending',
        head: sha,
        detail: { outcome: 'pending', polls: i, reason: 'waiting for: test' },
      });
    }
    plan = planJob(store, c.id);
    expect(plan.ci).toMatchObject({
      polls: CI_MAX_SESSION_POLLS,
      sessionPolls: CI_MAX_SESSION_POLLS,
      waitSeconds: 240,
      release: true,
    });
    expect(plan.commands).toEqual([`orch job release ${c.id} --token <token>`]);
    expect(plan.reason).toContain('Release the job');
    // Another session starts its own count; the head's total keeps growing and so does the wait.
    const h = resumeFactoryJob(store, c.id, { session: 'claude-later-0003', force: true });
    expect(h.plan.ci).toMatchObject({
      polls: CI_MAX_SESSION_POLLS,
      sessionPolls: 0,
      release: false,
    });
    expect(h.plan.commands[1]).toBe(`orch gh ci ${c.id} --token <token>`);
    const c2 = { ...c, token: h.token };
    go(store, c2, 'start');
    expect(reconcile(c2)).toMatchObject({
      polls: CI_MAX_SESSION_POLLS + 1,
      waitSeconds: 300,
      action: 'wait',
    });
    expect(planJob(store, c.id).ci).toMatchObject({ sessionPolls: 1, release: false });
  });
});

describe('ci stage: releasing a pending job', () => {
  it('changes ownership only; an ordinary resume reconciles GitHub afresh with the same budgets', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const failed = run('test', 'failure');
    shim.write({
      api: {
        ...shim.read().api,
        [`repos/acme/alpha/actions/jobs/${String(failed.id)}`]: { run_id: 7 },
      },
    });
    checks(sha, [failed]);
    // The head's one re-run is spent; the new attempt is queued for the rest of the session.
    expect(reconcile(c)).toMatchObject({ action: 'wait', reruns: 1 });
    checks(sha, [run('test', null, 'queued')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'pending', action: 'wait' });
    for (let i = 3; i <= CI_MAX_SESSION_POLLS; i++) {
      recordCi(store, c.id, {
        token: c.token,
        ciStatus: 'pending',
        head: sha,
        detail: { outcome: 'pending', polls: i, reason: 'waiting for: test' },
      });
    }
    expect(planJob(store, c.id).commands).toEqual([`orch job release ${c.id} --token <token>`]);
    const before = job(c);
    const eventsBefore = listEvents(store.db, c.id, 1000).length;

    // Only the owner can release; releasing records one event and touches nothing but the lease.
    expect(() => releaseJob(store, c.id, { token: 'not-the-owner' })).toThrow(OwnershipError);
    const released = releaseJob(store, c.id, { token: c.token });
    expect(released).toMatchObject({
      stage: 'ci',
      status: 'running',
      ciStatus: 'pending',
      ciHead: sha,
      ciRepairs: 0,
      prUrl: before.prUrl,
      prState: before.prState,
      ownerSession: null,
      ownerToken: null,
      leaseExpiresAt: null,
    });
    const events = listEvents(store.db, c.id, 1000);
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)?.type).toBe('job.released');
    expect(existsSync(before.worktreePath ?? '')).toBe(true);
    // The released token is dead: nothing can act on the job without claiming it.
    expect(() => reconcile(c)).toThrow(OwnershipError);
    expect(() => go(store, c, 'complete')).toThrow(OwnershipError);

    // An ordinary resume (no force, no takeover) starts the session count again and keeps the rest.
    const h = resumeFactoryJob(store, c.id, { session: 'claude-later-0004' });
    expect(h.tookOver).toBe(false);
    expect(h.plan.ci).toMatchObject({
      head: sha,
      current: true,
      polls: CI_MAX_SESSION_POLLS,
      sessionPolls: 0,
      reruns: 1,
      release: false,
    });
    expect(h.plan.commands).toEqual([
      `orch gh ci ${c.id} --token <token>`,
      `orch factory next ${c.id}`,
    ]);
    expect(h.job).toMatchObject({
      stage: 'ci',
      status: 'running',
      ciRepairs: 0,
      prUrl: before.prUrl,
    });
    const c2 = { ...c, token: h.token };
    // Still pending: the head gets no second re-run, and the new session has its own release budget.
    expect(reconcile(c2)).toMatchObject({
      action: 'wait',
      reruns: 1,
      polls: CI_MAX_SESSION_POLLS + 1,
      waitSeconds: 300,
    });
    expect(shim.read().calls.filter((x) => x[0] === 'run' && x[1] === 'rerun')).toHaveLength(1);
    expect(planJob(store, c.id).ci).toMatchObject({ sessionPolls: 1, release: false });
    // GitHub's verdict for the same head completes the job on the same PR; no repair was spent.
    checks(sha, [run('test', 'success')]);
    expect(reconcile(c2)).toMatchObject({ outcome: 'passing', action: 'complete', head: sha });
    expect(job(c2)).toMatchObject({ stage: 'completed', ciStatus: 'passing', ciHead: sha });
    expect(job(c2)).toMatchObject({ ciRepairs: 0, prUrl: before.prUrl });
    expect(ghCalls('create')).toHaveLength(1);
  });
});
