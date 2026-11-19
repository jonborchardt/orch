/**
 * A PR a human merged while the job was in ci: `orch gh ci` (or `orch gh pr status --token`)
 * completes the job when the merge is the job's own PR at the verified, approved worktree HEAD,
 * and escalates otherwise. It never waits on checks, re-runs, or reworks after a merge.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { cannotAcceptDelivery, completionOf } from '../src/core/workflow.ts';
import { formatPlan } from '../src/cli/output.ts';
import { planJob } from '../src/ops/factory.ts';
import { prStatus } from '../src/ops/github.ts';
import { board, detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import { type Ctx, head, start, toCi } from './drive.ts';
import { commitFile, gitIn } from './helpers.ts';
import { checks, clone, ghCalls, job, reconcile, run, shim, store } from './ci-fixture.ts';

const events = (c: Ctx, type: string) =>
  listEvents(store.db, c.id, 1000)
    .filter((e) => e.type === type)
    .map((e) => e.payload);
/** Edit the newest PR (the latest job's). */
const editPr = (patch: Record<string, unknown>) => {
  const st = shim.read();
  const i = st.prs.length - 1;
  st.prs[i] = { ...st.prs[i], ...patch };
  shim.write({ prs: st.prs });
};

/** A ci job whose PR a human merged at its head, with the checks GitHub reports for it. */
function mergedWith(conclusion: string | null, status = 'completed'): { c: Ctx; sha: string } {
  const c = start(store, clone);
  toCi(store, c);
  const sha = head(c.wt);
  checks(sha, [run('test', conclusion, status)]);
  editPr({ state: 'MERGED' });
  return { c, sha };
}

describe('ci stage: a PR merged by a human', () => {
  it('completes a job whose checks are still queued, recording how it ended', () => {
    const { c, sha } = mergedWith(null, 'queued');
    const r = reconcile(c);
    expect(r).toMatchObject({ action: 'complete', outcome: 'merged', ready: 'already' });
    expect(r.reason).toContain('PR merged by a human');
    expect(ghCalls('ready')).toHaveLength(0);
    const j = job(c);
    expect(j).toMatchObject({
      stage: 'completed',
      status: 'completed',
      prState: 'merged',
      ciStatus: 'pending',
      ciHead: sha,
      ownerSession: null,
      ownerToken: null,
    });
    expect(j.completedAt).toBeTruthy();
    const done = events(c, 'job.completed').at(-1);
    expect(done).toMatchObject({
      mergedByHuman: true,
      head: sha,
      ciStatus: 'pending',
      reason: 'merged by a human before CI finished',
    });
    expect(completionOf('completed', done)).toBe('merged');

    // AC8: read models lead with the merge.
    const d = detail(store, c.id);
    expect(d.outcome?.kind).toBe('merged');
    expect(d.ci.completion).toBe('merged');
    expect(d.ci.line).toMatch(/^PR merged by a human before CI finished/);
    const row = board(store).find((x) => x.id === c.id);
    expect(row?.outcome?.kind).toBe('merged');
    expect(row?.ci.line).toMatch(/^PR merged by a human before CI finished/);

    // AC9: the plan is done, its reason starts with the merge, and nothing says "CI pending".
    const plan = planJob(store, c.id);
    expect(plan.step).toBe('done');
    expect(plan.reason).toMatch(/^PR merged/);
    const text = formatPlan(plan);
    expect(text).toContain('Nothing; the job is done');
    expect(text).toMatch(/Reason:\s+PR merged/);
    expect(text).not.toContain('CI pending');
    // Nothing merged or marked ready by orch.
    expect(shim.read().calls.some((x) => x[1] === 'merge')).toBe(false);
  });

  it('completes on failing checks without a re-run, rework, repair, or logs', () => {
    const { c } = mergedWith('failure');
    shim.write({ logs: {} });
    const repairs = job(c).ciRepairs;
    const r = reconcile(c);
    expect(r).toMatchObject({ action: 'complete', failures: [], ciStatus: 'failing' });
    expect(events(c, 'ci.rerun')).toEqual([]);
    expect(events(c, 'job.reworked')).toEqual([]);
    expect(job(c)).toMatchObject({ stage: 'completed', ciRepairs: repairs, ciStatus: 'failing' });
    expect(events(c, 'job.completed').at(-1)).toMatchObject({ mergedByHuman: true });
    expect(
      shim.read().calls.some((x) => x[0] === 'run' || x.some((a) => a.includes('/logs'))),
    ).toBe(false);
  });

  it('a merge with passing checks completes exactly as a passing verdict', () => {
    const { c } = mergedWith('success');
    expect(reconcile(c)).toMatchObject({ action: 'complete', outcome: 'passing' });
    const done = events(c, 'job.completed').at(-1);
    expect(done?.['mergedByHuman']).toBeUndefined();
    expect(completionOf('completed', done)).toBe('ci');
  });

  it('escalates when the delivery gate refuses the merged head', () => {
    // Dirty tree.
    const { c } = mergedWith(null, 'queued');
    writeFileSync(join(c.wt, 'stray.txt'), 'x\n');
    const r = reconcile(c);
    expect(r.action).toBe('escalate');
    expect(r.reason).toContain('PR merged by a human at');
    expect(r.reason).toContain('uncommitted changes');
    expect(job(c)).toMatchObject({ stage: 'needs-human', status: 'blocked', returnStage: 'ci' });

    // An unapproved commit pushed and merged: the PR head is the worktree HEAD, but not approved.
    const d = start(store, clone);
    toCi(store, d);
    commitFile(d.wt, 'late.txt', 'late\n', 'late change');
    gitIn(d.wt, 'push', 'origin', 'HEAD');
    checks(head(d.wt), [run('test', null, 'queued')]);
    editPr({ state: 'MERGED' });
    const e = reconcile(d);
    expect(e.action).toBe('escalate');
    expect(e.reason).toMatch(/PR merged by a human at .*not approved/);
    expect(job(d)).toMatchObject({ stage: 'needs-human', returnStage: 'ci', prState: 'merged' });
    expect(detail(store, d.id).blocker?.summary).toBe(
      'PR merged by a human, but delivery was refused',
    );
  });

  it('a merge of another head or a foreign PR keeps the outdated escalation', () => {
    const { c } = mergedWith(null, 'queued');
    // The worktree moved past the merged PR head.
    commitFile(c.wt, 'after.txt', 'after\n', 'after merge');
    const r = reconcile(c);
    expect(r).toMatchObject({ action: 'escalate', outcome: 'outdated' });
    expect(r.reason).toContain('the branch changed outside the job');
    expect(job(c)).toMatchObject({ stage: 'needs-human', returnStage: 'ci', prState: 'merged' });
    expect(cannotAcceptDelivery(job(c))).toBeNull();

    const d = start(store, clone);
    toCi(store, d);
    editPr({ state: 'MERGED', baseRefName: 'other' });
    const f = reconcile(d);
    expect(f).toMatchObject({ action: 'escalate', outcome: 'outdated' });
    expect(f.reason).toContain("not the job's");
    expect(job(d)).toMatchObject({ stage: 'needs-human', returnStage: 'ci', prState: 'merged' });
    expect(cannotAcceptDelivery(job(d))).toBeNull();
  });

  it('orch gh pr status --token completes a running ci job whose PR merged; without, records nothing', () => {
    const { c, sha } = mergedWith(null, 'queued');
    const before = job(c).revision;
    const peek = prStatus(store, c.id);
    expect(peek.recorded).toBe(false);
    expect(job(c).revision).toBe(before);
    expect(job(c).stage).toBe('ci');
    const s = prStatus(store, c.id, { token: c.token });
    expect(s).toMatchObject({ recorded: true, prState: 'merged', ciStatus: 'pending' });
    expect(job(c)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      prState: 'merged',
      ciStatus: 'pending',
      ciHead: sha,
      ownerToken: null,
    });
    expect(events(c, 'job.completed').at(-1)).toMatchObject({ mergedByHuman: true, head: sha });
  });
});
