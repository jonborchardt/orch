/**
 * Post-PR CI reconciliation: the ci stage reads GitHub's verdict for the exact PR head through a
 * stateful `gh` shim, waits on pending checks, repairs failing ones through the normal build ->
 * review -> approve -> pr cycle on the same PR, bounds those repairs, escalates what it cannot
 * resolve, and never completes a job on a verdict for another commit.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CI_GRACE_POLLS, evaluateChecks } from '../src/core/ci.ts';
import { ToolError, ValidationError } from '../src/core/errors.ts';
import { MAX_CI_REPAIRS_REASON } from '../src/core/workflow.ts';
import { configPath, planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { ensureDraftPr, prStatus, pushBranch, reconcileCi } from '../src/ops/github.ts';
import { verificationStatus } from '../src/ops/verify.ts';
import { worktreeOf } from '../src/ops/tree.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import {
  add,
  approve,
  type Ctx,
  deliverPr,
  go,
  head,
  makePolicyRepo,
  passRound,
  prFile,
  start,
  toCi,
  toPr,
  verify,
} from './drive.ts';
import {
  commitFile,
  fixture,
  type GhShim,
  ghShim,
  gitIn,
  json,
  orch,
  type ShimCheckRun,
  tempDir,
  type TempStore,
  tempStore,
} from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
let shim: GhShim;

beforeAll(() => {
  shim = ghShim('acme/alpha');
  Object.assign(process.env, shim.env);
});
afterAll(() => {
  delete process.env['ORCH_GH_SHIM'];
  delete process.env['ORCH_GH_SHIM_STATE'];
  shim.cleanup();
});
beforeEach(() => {
  shim.reset();
  store = tempStore();
  ({ clone, bare } = makePolicyRepo());
  // GitHub knows the pushed head: the shim reads PR heads from the local origin.
  shim.write({ bare });
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
});

let nextId = 100;
function run(
  name: string,
  conclusion: string | null,
  status = 'completed',
  app = 'github-actions',
): ShimCheckRun {
  nextId += 1;
  return {
    id: nextId,
    name,
    status,
    conclusion,
    html_url: `https://github.com/acme/alpha/actions/runs/1/job/${String(nextId)}`,
    app: { slug: app },
  };
}

/** Check runs GitHub reports for `sha` (`*` for every commit). */
function checks(sha: string, runs: ShimCheckRun[]): void {
  shim.write({ checkRuns: { ...(shim.read().checkRuns ?? {}), [sha]: runs } });
}

const reconcile = (c: Ctx) => reconcileCi(store, c.id, { token: c.token });
const job = (c: Ctx) => getJob(store.db, c.id);
const observed = (c: Ctx) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type === 'ci.observed');
const ghCalls = (sub: string) => shim.read().calls.filter((x) => x[0] === 'pr' && x[1] === sub);

/** The builder's repair after a CI rework: commit, verify, build.md, review, approve, push. */
function repair(c: Ctx, file: string): string {
  expect(job(c).stage).toBe('build');
  go(store, c, 'start');
  const sha = commitFile(c.wt, file, `// fixed ${file}\n`, `fix ${file}`);
  verify(store, c);
  add(store, c, 'build.md', fixture('build.md'), true);
  go(store, c, 'complete');
  passRound(store, c);
  approve(store, c, true);
  go(store, c, 'start');
  deliverPr(store, c);
  go(store, c, 'start');
  return sha;
}

describe('evaluateChecks (pure)', () => {
  const ok = { name: 'test', status: 'completed', conclusion: 'success', url: null, jobId: 1 };
  const bad = { ...ok, name: 'lint', conclusion: 'failure', jobId: 2 };
  const running = { ...ok, name: 'build', status: 'in_progress', conclusion: '' };

  it('treats every reported check as required when GitHub has no configuration', () => {
    expect(evaluateChecks([ok], null, 1)).toMatchObject({
      outcome: 'passing',
      required: ['test'],
      configured: false,
    });
    expect(evaluateChecks([ok, bad], null, 1)).toMatchObject({ outcome: 'failing' });
    expect(evaluateChecks([ok, running], null, 1)).toMatchObject({
      outcome: 'pending',
      pending: ['build'],
    });
    // A failure does not wait for the rest to finish.
    expect(evaluateChecks([bad, running], null, 1).outcome).toBe('failing');
  });

  it('an empty or skipped-only list is a wait during the grace window, then "none"', () => {
    expect(evaluateChecks([], null, 1).outcome).toBe('pending');
    expect(evaluateChecks([], null, CI_GRACE_POLLS - 1).outcome).toBe('pending');
    expect(evaluateChecks([], null, CI_GRACE_POLLS).outcome).toBe('none');
    const skipped = { ...ok, conclusion: 'skipped' };
    expect(evaluateChecks([skipped], null, 1).outcome).toBe('pending');
    expect(evaluateChecks([skipped], null, CI_GRACE_POLLS).outcome).toBe('none');
    // Skipped counts as passing only when a human made the check required.
    expect(evaluateChecks([skipped], ['test'], CI_GRACE_POLLS).outcome).toBe('passing');
    expect(evaluateChecks([], [], CI_GRACE_POLLS).outcome).toBe('none');
  });

  it('with a configured list, optional failures do not matter and missing required ones do', () => {
    const r = evaluateChecks([ok, bad], ['test'], 1);
    expect(r.outcome).toBe('passing');
    expect(r.optionalFailed).toEqual(['lint']);
    expect(evaluateChecks([ok], ['test', 'e2e'], 1)).toMatchObject({
      outcome: 'pending',
      missing: ['e2e'],
    });
    expect(evaluateChecks([ok], ['test', 'e2e'], CI_GRACE_POLLS)).toMatchObject({
      outcome: 'infrastructure',
      missing: ['e2e'],
    });
    expect(evaluateChecks([bad], ['lint'], 1).outcome).toBe('failing');
  });

  it('cancelled, stale, startup failures, and action_required are infrastructure, not defects', () => {
    for (const k of ['cancelled', 'stale', 'startup_failure', 'action_required', 'error']) {
      const r = evaluateChecks([{ ...ok, conclusion: k }], null, 1);
      expect(r.outcome, k).toBe('infrastructure');
      expect(r.infrastructure).toHaveLength(1);
    }
    expect(evaluateChecks([{ ...ok, conclusion: 'timed_out' }], null, 1).outcome).toBe('failing');
    // Neutral is not a failure, but on its own it verified nothing.
    expect(evaluateChecks([{ ...ok, conclusion: 'neutral' }], null, 1).outcome).toBe('pending');
    expect(evaluateChecks([ok, { ...bad, conclusion: 'neutral' }], null, 1).outcome).toBe(
      'passing',
    );
  });
});

describe('ci stage: pending, then passing', () => {
  it('waits while checks run, binds the verdict to the PR head, and completes only on passing', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    // PR creation records the rollup but no head: nothing has been read for this commit yet.
    expect(job(c)).toMatchObject({
      stage: 'ci',
      status: 'running',
      ciHead: null,
      ciStatus: 'none',
    });
    expect(() => go(store, c, 'complete')).toThrow(/run orch gh ci/);

    checks(sha, [run('test', null, 'in_progress')]);
    const viewsBefore = ghCalls('view').length;
    const r1 = reconcile(c);
    expect(r1).toMatchObject({
      outcome: 'pending',
      action: 'wait',
      current: true,
      head: sha,
      ciStatus: 'pending',
      polls: 1,
    });
    expect(job(c)).toMatchObject({
      stage: 'ci',
      status: 'running',
      ciStatus: 'pending',
      ciHead: sha,
    });
    expect(() => go(store, c, 'complete')).toThrow(/required checks are pending/);
    const plan = planJob(store, c.id);
    expect(plan.step).toBe('run-stage');
    expect(plan.commands).toEqual([
      `orch gh ci ${c.id} --token <token>`,
      `orch factory next ${c.id}`,
    ]);
    expect(plan.ci).toMatchObject({ head: sha, current: true, polls: 1, repairs: 0 });
    expect(plan.reason).toContain('never polls by itself');
    // One `gh pr view` per reconciliation: the CLI does not loop on its own.
    expect(ghCalls('view')).toHaveLength(viewsBefore + 1);

    checks(sha, [run('test', 'success')]);
    const r2 = reconcile(c);
    expect(r2).toMatchObject({ outcome: 'passing', action: 'complete', polls: 2 });
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running', ciStatus: 'passing' });
    expect(planJob(store, c.id).commands).toEqual([
      `orch job transition ${c.id} complete --token <token>`,
    ]);
    const done = go(store, c, 'complete');
    expect([done.stage, done.status]).toEqual(['completed', 'completed']);
    const final = planJob(store, c.id);
    expect(final.step).toBe('done');
    expect(final.reason).toContain(`checks passing for ${sha.slice(0, 7)}`);
    const completed = listEvents(store.db, c.id, 1000).find((e) => e.type === 'job.completed');
    expect(completed?.payload).toEqual({
      prUrl: 'https://github.com/acme/alpha/pull/1',
      head: sha,
    });
    // Every observation names the commit and GitHub's answer.
    expect(observed(c).map((e) => e.payload['outcome'])).toEqual([undefined, 'pending', 'passing']);
    expect(observed(c).at(-1)?.payload).toMatchObject({
      head: sha,
      current: true,
      required: ['test'],
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    });
    // Nothing merged, nothing marked ready.
    expect(shim.read().calls.some((x) => x[1] === 'merge' || x[1] === 'ready')).toBe(false);
    expect((shim.read().prs[0] as { isDraft: boolean }).isDraft).toBe(true);
  });

  it('is refused outside a running ci stage and needs the owner token', () => {
    const c = start(store, clone);
    toPr(store, c);
    expect(() => reconcile(c)).toThrow(/while the ci stage is running/);
    deliverPr(store, c);
    expect(() => reconcile(c)).toThrow(/ci\/pending/);
    go(store, c, 'start');
    expect(() => reconcileCi(store, c.id, { token: 'bad' })).toThrow(/Stale or invalid token/);
  });
});

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
    expect(go(store, c, 'complete').stage).toBe('completed');
    expect(job(c).ciRepairs).toBe(1);
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
    expect(go(store, c2, 'complete').stage).toBe('completed');
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
    expect(() => go(store, c2, 'complete')).toThrow(/required checks are pending/);
    checks(sha, [run('test', 'success')]);
    const again = reconcile(c2);
    expect(again).toMatchObject({ action: 'complete', head: sha, polls: 2 });
    expect(go(store, c2, 'complete').stage).toBe('completed');
    expect(ghCalls('create')).toHaveLength(1);
  });
});

describe('ci stage: the verdict is bound to the PR head', () => {
  it('a passing result for an older commit never completes a newer HEAD', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha1 = head(c.wt);
    checks(sha1, [run('test', 'success')]);
    expect(reconcile(c).action).toBe('complete');
    // The branch moves (here: a commit landed in the worktree and was pushed outside orch).
    const sha2 = commitFile(c.wt, 'src/late.ts', '// late\n', 'late change');
    gitIn(c.wt, 'push', '-q', 'origin', 'HEAD');
    expect(() => go(store, c, 'complete')).toThrow(/CI was last observed for/);
    expect(job(c).stage).toBe('ci');
    // Reconciling reads the new head, for which GitHub reports nothing yet: pending, not passing.
    const r = reconcile(c);
    expect(r).toMatchObject({ head: sha2, outcome: 'pending', action: 'wait', current: true });
    expect(job(c)).toMatchObject({ ciHead: sha2, ciStatus: 'pending' });
    // And the unverified late commit is refused by the verification gate on top of that.
    expect(() => go(store, c, 'complete')).toThrow(/valid verification run/);
  });

  it('a branch updated outside the job while CI runs is escalated, not completed', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha1 = head(c.wt);
    checks('*', [run('test', 'success')]);
    // Someone pushes a new commit to the PR branch; the worktree still sits at the approved HEAD.
    const tree = gitIn(c.wt, 'rev-parse', 'HEAD^{tree}');
    const outside = gitIn(c.wt, 'commit-tree', tree, '-p', 'HEAD', '-m', 'pushed from elsewhere');
    gitIn(c.wt, 'push', '-q', 'origin', `${outside}:refs/heads/${job(c).branch ?? ''}`);
    const r = reconcile(c);
    expect(r).toMatchObject({
      outcome: 'outdated',
      action: 'escalate',
      head: outside,
      current: false,
    });
    expect(r.reason).toContain(outside.slice(0, 7));
    expect(r.reason).toContain(sha1.slice(0, 7));
    expect(job(c)).toMatchObject({ stage: 'needs-human', returnStage: 'ci', ciHead: outside });
    expect(planJob(store, c.id).blockedReason).toContain('changed outside the job');
  });

  it("GitHub's own stale head report is outdated as well", () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    checks('*', [run('test', 'success')]);
    const st = shim.read();
    st.prs[0] = { ...st.prs[0], headRefOid: 'a'.repeat(40) };
    shim.write({ prs: st.prs, bare: undefined });
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'outdated', head: 'a'.repeat(40), current: false });
    expect(job(c).stage).toBe('needs-human');
    expect(job(c).ciHead).not.toBe(sha);
  });
});

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
    expect(() => go(store, c, 'complete')).toThrow(/run orch gh ci/);

    // The per-commit read sees the skipped-only run for what it is: nothing verified yet.
    checks(sha, [run('test', 'skipped')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'pending', action: 'wait', head: sha });
    expect(() => go(store, c, 'complete')).toThrow(/required checks are pending/);

    // A real verdict completes; a later `pr status --token` rollup drops the head again, so the
    // next completion needs a fresh `orch gh ci`.
    checks(sha, [run('test', 'success')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'passing', action: 'complete', head: sha });
    expect(job(c)).toMatchObject({ ciStatus: 'passing', ciHead: sha });
    prStatus(store, c.id, { token: c.token });
    expect(job(c)).toMatchObject({ ciStatus: 'passing', ciHead: null });
    expect(planJob(store, c.id).commands[0]).toBe(`orch gh ci ${c.id} --token <token>`);
    expect(() => go(store, c, 'complete')).toThrow(/run orch gh ci/);
    expect(reconcile(c)).toMatchObject({ outcome: 'passing', head: sha });
    expect(go(store, c, 'complete').stage).toBe('completed');
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
    expect(() => go(store, c, 'complete')).toThrow(/run orch gh ci/);
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
    // Rulesets are honoured too, and without any configuration every check counts.
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
    expect(reconcile(c).outcome).toBe('passing');
    shim.write({ rules: [] });
    expect(reconcile(c)).toMatchObject({ outcome: 'failing', action: 'rework' });
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
    expect(job(c).stage).toBe('needs-human');
    expect(gitIn(bare, 'rev-parse', `refs/heads/${job(c).branch ?? ''}`)).toBe(head(c.wt));
  });
});

describe('orch gh ci on the command line', () => {
  it('prints the reconciliation as JSON and reports usage errors', () => {
    const c = start(store, clone);
    toCi(store, c);
    checks('*', [run('test', null, 'in_progress')]);
    const home = store.home;
    const r = json<{ action: string; outcome: string; head: string }>(
      orch(
        home,
        tempDir('orch-ci-cwd-'),
        ['--json', 'gh', 'ci', c.id, '--token', c.token],
        shim.env,
      ),
    );
    expect(r).toMatchObject({ action: 'wait', outcome: 'pending', head: head(c.wt) });
    expect(orch(home, clone, ['gh', 'ci'], shim.env).code).toBe(2);
    expect(orch(home, clone, ['gh', 'ci', c.id, '--token', 'nope'], shim.env).code).toBe(4);
    expect(() => ensureDraftPr(store, c.id, { token: c.token, bodyFile: prFile(c) })).toThrow(
      ValidationError,
    );
  });
});
