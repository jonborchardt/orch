/**
 * Post-PR CI reconciliation: the ci stage reads GitHub's verdict for the exact PR head through a
 * stateful `gh` shim, waits on pending checks, and never completes a job on a verdict for another
 * commit. Repairs, re-runs, GitHub answers that are not verdicts, and delivery gates live in the
 * other ci-*.test.ts and delivery.test.ts files (one file runs serially; several run in parallel).
 */
import { describe, expect, it } from 'vitest';
import { CI_GRACE_POLLS, evaluateChecks, waitSeconds } from '../src/core/ci.ts';
import { ValidationError } from '../src/core/errors.ts';
import { planJob } from '../src/ops/factory.ts';
import { ensureDraftPr, reconcileCi } from '../src/ops/github.ts';
import { listEvents } from '../src/storage/events.ts';
import { recordCi, transitionJob } from '../src/storage/jobs.ts';
import { deliverPr, go, head, prFile, start, toCi, toPr } from './drive.ts';
import { commitFile, gitIn, json, orch, tempDir } from './helpers.ts';
import {
  store,
  clone,
  shim,
  run,
  checks,
  reconcile,
  job,
  observed,
  ghCalls,
} from './ci-fixture.ts';

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
    expect(() => reconcile(c)).toThrow(/commits that were not approved/);
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
