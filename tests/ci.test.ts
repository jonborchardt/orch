/**
 * Post-PR CI reconciliation: the ci stage reads GitHub's verdict for the exact PR head through a
 * stateful `gh` shim, waits on pending checks, repairs failing ones through the normal build ->
 * review -> approve -> pr cycle on the same PR, bounds those repairs, escalates what it cannot
 * resolve, and never completes a job on a verdict for another commit.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CI_GRACE_POLLS,
  CI_MAX_SESSION_POLLS,
  evaluateChecks,
  waitSeconds,
} from '../src/core/ci.ts';
import { OwnershipError, ToolError, ValidationError } from '../src/core/errors.ts';
import { MAX_CI_REPAIRS_REASON } from '../src/core/workflow.ts';
import { configPath, planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { ensureDraftPr, prStatus, pushBranch, reconcileCi } from '../src/ops/github.ts';
import { verificationStatus } from '../src/ops/verify.ts';
import { worktreeOf } from '../src/ops/tree.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob, recordCi, releaseJob, transitionJob } from '../src/storage/jobs.ts';
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
  const ok = {
    id: 1,
    suiteId: null,
    name: 'test',
    status: 'completed',
    conclusion: 'success',
    url: null,
    jobId: 1,
  };
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
    // Skipped-only verified nothing even when a human made the check required (GitHub would
    // count it): the factory escalates and the human closes out explicitly if that is right.
    expect(evaluateChecks([skipped], ['test'], 1).outcome).toBe('pending');
    expect(evaluateChecks([skipped], ['test'], CI_GRACE_POLLS).outcome).toBe('none');
    // An optional check that ran does not make a skipped required check count as verified.
    expect(
      evaluateChecks([skipped, { ...ok, name: 'lint' }], ['test'], CI_GRACE_POLLS).outcome,
    ).toBe('none');
    expect(evaluateChecks([ok, { ...skipped, name: 'lint' }], ['test', 'lint'], 1).outcome).toBe(
      'passing',
    );
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
    expect(() => go(store, c, 'complete')).toThrow(/completed by orch gh ci/);
    expect(() => transitionJob(store, c.id, 'complete', { token: c.token })).toThrow(
      /no CI verdict has been read/,
    );

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
    expect(() => go(store, c, 'complete')).toThrow(/completed by orch gh ci/);
    expect(() => transitionJob(store, c.id, 'complete', { token: c.token })).toThrow(
      /required checks are pending/,
    );
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
    // The passing read completes the job in the same call: no separate `complete` step exists.
    expect([r2.job.stage, r2.job.status]).toEqual(['completed', 'completed']);
    expect(job(c)).toMatchObject({ stage: 'completed', ciStatus: 'passing', ciHead: sha });
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

describe('ci stage: the verdict is bound to the PR head', () => {
  it('a passing result for an older commit never completes a newer HEAD', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha1 = head(c.wt);
    // A passing verdict exists for the approved commit (recorded storage-level so that the stage
    // stays open: a live read would have completed the job on the spot).
    recordCi(store, c.id, { token: c.token, ciStatus: 'passing', head: sha1 });
    // The branch moves (here: a commit landed in the worktree and was pushed outside orch).
    const sha2 = commitFile(c.wt, 'src/late.ts', '// late\n', 'late change');
    gitIn(c.wt, 'push', '-q', 'origin', 'HEAD');
    expect(() => go(store, c, 'complete')).toThrow(/completed by orch gh ci/);
    expect(job(c).stage).toBe('ci');
    // Reconciling reads the new head, for which GitHub reports nothing yet: pending, not passing.
    const r = reconcile(c);
    expect(r).toMatchObject({ head: sha2, outcome: 'pending', action: 'wait', current: true });
    expect(job(c)).toMatchObject({ ciHead: sha2, ciStatus: 'pending' });
    // Even a passing read for the late commit is refused: it was never verified or approved.
    checks(sha2, [run('test', 'success')]);
    expect(() => reconcile(c)).toThrow(/valid verification run/);
    expect(job(c)).toMatchObject({ stage: 'ci', ciHead: sha2, ciStatus: 'passing' });
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
    expect(job(c2)).toMatchObject({ stage: 'completed', prState: 'draft' });
  });
});

describe('evaluateChecks: duplicate names and the polling schedule', () => {
  const ok = {
    id: 1,
    suiteId: null,
    name: 'test',
    status: 'completed',
    conclusion: 'success',
    url: null,
    jobId: 1,
  };

  it('when several runs share a name the worst one counts, whatever the order', () => {
    const failed = { ...ok, id: 2, conclusion: 'failure' };
    const running = { ...ok, id: 3, status: 'in_progress', conclusion: '' };
    const cancelled = { ...ok, id: 4, conclusion: 'cancelled' };
    expect(evaluateChecks([ok, failed], null, 1).outcome).toBe('failing');
    expect(evaluateChecks([failed, ok], null, 1).outcome).toBe('failing');
    expect(evaluateChecks([ok, running], null, 1).outcome).toBe('pending');
    expect(evaluateChecks([cancelled, running], null, 1).outcome).toBe('pending');
    expect(evaluateChecks([ok, cancelled], ['test'], 1).outcome).toBe('infrastructure');
    expect(evaluateChecks([running, failed], null, 1).outcome).toBe('failing');
  });

  it('attempts of one check (same suite and name) collapse to the newest; independent checks do not', () => {
    const inSuite = (c: typeof ok, suiteId: number) => ({ ...c, suiteId });
    const oldFail = inSuite({ ...ok, id: 2, conclusion: 'failure' }, 10);
    const oldPass = inSuite({ ...ok, id: 2 }, 10);
    const newPass = inSuite({ ...ok, id: 3 }, 10);
    const newFail = inSuite({ ...ok, id: 3, conclusion: 'failure' }, 10);
    const newQueued = inSuite({ ...ok, id: 3, status: 'queued', conclusion: '' }, 10);
    // The initial attempt failed and its re-run passed, whichever page each came on.
    expect(evaluateChecks([oldFail, newPass], ['test'], 1).outcome).toBe('passing');
    expect(evaluateChecks([newPass, oldFail], ['test'], 1).outcome).toBe('passing');
    // The initial attempt passed and its re-run failed: the current attempt is the verdict.
    expect(evaluateChecks([oldPass, newFail], ['test'], 1)).toMatchObject({
      outcome: 'failing',
      failed: [newFail],
    });
    // The newest attempt is still running while an older one passed.
    expect(evaluateChecks([oldPass, newQueued], ['test'], 1)).toMatchObject({
      outcome: 'pending',
      pending: ['test'],
    });
    // Several attempts: only the newest id counts.
    const midFail = inSuite({ ...ok, id: 4, conclusion: 'failure' }, 10);
    const last = inSuite({ ...ok, id: 5 }, 10);
    expect(evaluateChecks([midFail, oldFail, last], ['test'], 1).outcome).toBe('passing');
    // A re-run of the failed jobs only: lint keeps its first attempt, test gets a new one.
    const lint = inSuite({ ...ok, id: 1, name: 'lint' }, 10);
    expect(evaluateChecks([lint, oldFail, newPass], ['lint', 'test'], 1).outcome).toBe('passing');
    // Two independent checks with the same name (different suites): the worst one counts.
    const other = inSuite({ ...ok, id: 3 }, 11);
    expect(evaluateChecks([oldFail, other], ['test'], 1).outcome).toBe('failing');
    expect(evaluateChecks([other, oldFail], ['test'], 1).outcome).toBe('failing');
    // Without a suite id the duplicate is ambiguous and still counts at its worst.
    const noSuite = [
      { ...ok, id: 2, conclusion: 'failure' },
      { ...ok, id: 3 },
    ];
    expect(evaluateChecks(noSuite, ['test'], 1).outcome).toBe('failing');
    // A commit status with a check run's name is another check, never an attempt of it.
    const status = { ...ok, id: null, jobId: null, conclusion: 'failure' };
    expect(evaluateChecks([newPass, status], ['test'], 1).outcome).toBe('failing');
  });

  it('the wait grows with the observations of a head and is capped at five minutes', () => {
    expect([0, 1, 5, 6, 10, 11, 16, 21, 40].map(waitSeconds)).toEqual([
      60, 60, 60, 120, 120, 180, 240, 300, 300,
    ]);
  });
});

describe('ci stage: every page of checks is read', () => {
  it('detects a failed required check beyond the first 100 check runs, in one paginated call', () => {
    const c = start(store, clone);
    toCi(store, c);
    const sha = head(c.wt);
    const many = Array.from({ length: 149 }, (_, i) => run(`matrix-${String(i)}`, 'success'));
    const failed = run('test', 'failure');
    checks(sha, [...many.slice(0, 120), failed, ...many.slice(120)]);
    const r = reconcile(c);
    expect(r.evaluation.required).toHaveLength(150);
    expect(r.evaluation.failed.map((x) => x.name)).toEqual(['test']);
    expect(r.outcome).not.toBe('passing');
    const api = shim.read().calls.filter((x) => x[0] === 'api');
    const runs = api.filter((x) => x[1]?.includes('check-runs?'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
    expect(api.find((x) => x[1]?.includes('/status?'))).toEqual(
      expect.arrayContaining(['--paginate', '--slurp']),
    );
  });
});

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
    // Nothing merged, nothing marked ready, nothing pushed by the re-run.
    expect(shim.read().calls.some((x) => x[1] === 'merge' || x[1] === 'ready')).toBe(false);
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
