/**
 * `verification.authority: "ci"`: GitHub CI passes on the exact commit before review. A driven job
 * goes simplify -> pr -> ci -> review -> approve -> pr -> ci -> completed; only the last pass marks
 * the PR ready and releases the lease, and review and approval bind to the commit CI passed.
 */
import { describe, expect, it } from 'vitest';
import { completionOf } from '../src/core/workflow.ts';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { prStatus } from '../src/ops/github.ts';
import { findArtifact } from '../src/storage/artifacts.ts';
import { listEvents } from '../src/storage/events.ts';
import { listReviews } from '../src/storage/jobs.ts';
import {
  add,
  approve,
  type Ctx,
  deliverPr,
  go,
  head,
  passRound,
  SESSION,
  start,
  toReview,
  useCiAuthority,
  verdict,
  verify,
} from './drive.ts';
import { commitFile } from './helpers.ts';
import { checks, clone, ghCalls, job, reconcile, run, shim, store } from './ci-fixture.ts';

const isDraft = () => (shim.read().prs[0] as { isDraft: boolean }).isDraft;
const events = (c: Ctx, type: string) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type === type);

/** A ci-authority job through build and simplify, then the pre-review pr pass: ci, running. */
function toPreReviewCi(): Ctx {
  useCiAuthority(clone);
  const c = start(store, clone);
  toReview(store, c);
  expect(job(c)).toMatchObject({ stage: 'pr', status: 'pending' });
  go(store, c, 'start');
  deliverPr(store, c);
  expect(job(c)).toMatchObject({ stage: 'ci', status: 'pending' });
  go(store, c, 'start');
  return c;
}

describe('authority ci: CI before review', () => {
  it('runs pr and ci before review, keeps the PR a draft, and delivers after approval', () => {
    const c = toPreReviewCi();
    const sha = head(c.wt);
    // Pushed and a draft PR exists without any decision.md.
    expect(findArtifact(store.db, c.id, 'decision.md')).toBeUndefined();
    expect(isDraft()).toBe(true);
    expect(planJob(store, c.id).reason).toContain('moves the job to review');

    checks(sha, [run('test', 'success')]);
    const pre = reconcile(c);
    expect(pre).toMatchObject({ outcome: 'passing', action: 'complete', ready: null });
    expect(job(c)).toMatchObject({
      stage: 'review',
      status: 'pending',
      ciStatus: 'passing',
      ciHead: sha,
      prState: 'draft',
      ownerSession: SESSION,
      ownerToken: c.token,
    });
    expect(job(c).leaseExpiresAt).not.toBeNull();
    expect(ghCalls('ready')).toHaveLength(0);
    expect(events(c, 'pr.ready')).toHaveLength(0);
    expect(isDraft()).toBe(true);

    passRound(store, c);
    expect(job(c).stage).toBe('approve');
    approve(store, c);
    expect(job(c).stage).toBe('pr');
    go(store, c, 'start');
    deliverPr(store, c);
    go(store, c, 'start');
    const done = reconcile(c);
    expect(done).toMatchObject({ outcome: 'passing', action: 'complete', ready: 'marked' });
    expect(job(c)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ciHead: sha,
      prState: 'ready',
      ownerToken: null,
      leaseExpiresAt: null,
    });
    expect(ghCalls('ready')).toHaveLength(1);
    expect(completionOf('completed', events(c, 'job.completed').at(-1)?.payload)).toBe('ci');
    // Review verdicts, the approval and the final verdict describe one commit.
    expect(new Set(listReviews(store.db, c.id).map((r) => r.head))).toEqual(new Set([sha]));
    expect(findArtifact(store.db, c.id, 'decision.md')?.head).toBe(sha);
  });

  it('review and approval are refused unless CI passed for HEAD; resume --to ci recovers', () => {
    const c = toPreReviewCi();
    checks(head(c.wt), [run('test', 'success')]);
    reconcile(c);
    go(store, c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    add(store, c, `round-${String(job(c).round)}/consolidated.md`);
    // A token-bearing pr status records a rollup without a head: no verdict for HEAD any more.
    prStatus(store, c.id, { token: c.token });
    expect(job(c).ciHead).toBeNull();
    expect(() => go(store, c, 'complete')).toThrow(/GitHub CI the test gate/);

    go(store, c, 'escalate', 'CI verdict cleared');
    const { token } = resumeFactoryJob(store, c.id, { session: SESSION, to: 'ci', force: true });
    const c2 = { ...c, token };
    go(store, c2, 'start');
    expect(reconcile(c2)).toMatchObject({ action: 'complete', ready: null });
    expect(job(c2).stage).toBe('review');
    // The round's verdicts and consolidation are for this HEAD; now CI is too.
    go(store, c2, 'start');
    expect(go(store, c2, 'complete').stage).toBe('approve');
    go(store, c2, 'start');
    add(store, c2, 'decision.md');
    prStatus(store, c.id, { token });
    expect(() => go(store, c2, 'complete')).toThrow(/completing approve is refused: .*CI/);
  });

  it('after a CI repair the new build cannot be reviewed until a pr/ci pass passes for it', () => {
    const c = toPreReviewCi();
    checks(head(c.wt), [run('test', 'failure')]);
    expect(reconcile(c)).toMatchObject({ action: 'rework' });
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 1 });
    go(store, c, 'start');
    commitFile(c.wt, 'src/fix.ts', '// fixed\n');
    verify(store, c);
    add(store, c, 'build.md', undefined, true);
    go(store, c, 'complete');
    go(store, c, 'start');
    const round = String(job(c).round);
    add(store, c, `round-${round}/simplify-review.md`);
    add(store, c, `round-${round}/simplify.md`);
    expect(go(store, c, 'complete').stage).toBe('pr');
    // A human sends it straight to review: completing it is still refused.
    go(store, c, 'escalate', 'skip ahead');
    const { token } = resumeFactoryJob(store, c.id, {
      session: SESSION,
      to: 'review',
      force: true,
    });
    const c2 = { ...c, token };
    go(store, c2, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c2, r);
    add(store, c2, `round-${String(job(c2).round)}/consolidated.md`);
    expect(() => go(store, c2, 'complete')).toThrow(/CI is failing/);
  });

  it('a commit after approval goes back through review instead of being delivered', () => {
    const c = toPreReviewCi();
    checks('*', [run('test', 'success')]);
    reconcile(c);
    passRound(store, c);
    approve(store, c);
    go(store, c, 'start');
    commitFile(c.wt, 'src/after.ts', '// unapproved\n');
    verify(store, c);
    deliverPr(store, c);
    go(store, c, 'start');
    expect(reconcile(c)).toMatchObject({ action: 'complete', ready: null });
    expect(job(c)).toMatchObject({ stage: 'review', prState: 'draft' });
    expect(ghCalls('ready')).toHaveLength(0);
  });
});
