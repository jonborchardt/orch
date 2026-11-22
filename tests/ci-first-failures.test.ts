/**
 * `verification.authority: "ci"`: a pre-review CI pass that does not pass never reaches review.
 * Failures rework through `maxCiRepairs`; checks that cannot run, no checks, an outdated head, and
 * a human merge before review escalate.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CI_GRACE_POLLS } from '../src/core/ci.ts';
import { MAX_CI_REPAIRS_REASON } from '../src/core/workflow.ts';
import { listEvents } from '../src/storage/events.ts';
import { jobs } from '../src/storage/schema.ts';
import { type Ctx, deliverPr, go, head, start, toReview, useCiAuthority } from './drive.ts';
import { commitFile } from './helpers.ts';
import { checks, clone, ghCalls, job, reconcile, run, shim, store } from './ci-fixture.ts';

function toPreReviewCi(): Ctx {
  useCiAuthority(clone);
  const c = start(store, clone);
  toReview(store, c);
  go(store, c, 'start');
  deliverPr(store, c);
  go(store, c, 'start');
  return c;
}
const blockedReason = (c: Ctx) =>
  listEvents(store.db, c.id, 1000)
    .filter((e) => e.type === 'job.blocked')
    .at(-1)?.payload['reason'];

describe('authority ci: a pre-review pass that does not pass never reaches review', () => {
  it('failing CI reworks with the logs and a repair; after maxCiRepairs it blocks', () => {
    const c = toPreReviewCi();
    const sha = head(c.wt);
    const failed = run('test', 'failure');
    shim.write({ logs: { [String(failed.id)]: 'FAIL src/export.test.ts\n' } });
    checks(sha, [failed]);
    const r = reconcile(c);
    expect(r).toMatchObject({ outcome: 'failing', action: 'rework' });
    expect(r.reason).toContain(`ci/${sha.slice(0, 7)}/test.log`);
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 1, maxCiRepairs: 2 });

    // The same failure with the repairs spent blocks for a human.
    const d = toPreReviewCi();
    store.db.update(jobs).set({ ciRepairs: 2 }).where(eq(jobs.id, d.id)).run();
    checks(head(d.wt), [run('test', 'failure')]);
    expect(reconcile(d)).toMatchObject({ action: 'exhausted' });
    expect(job(d)).toMatchObject({ stage: 'needs-human', status: 'blocked' });
    expect(blockedReason(d)).toBe(MAX_CI_REPAIRS_REASON);
  });

  it('checks that cannot run, or no checks at all, escalate', () => {
    const c = toPreReviewCi();
    checks(head(c.wt), [run('test', 'startup_failure')]);
    // A startup failure without a named workflow run is not re-run: it escalates.
    expect(reconcile(c)).toMatchObject({ outcome: 'infrastructure', action: 'escalate' });
    expect(job(c).stage).toBe('needs-human');

    const d = toPreReviewCi();
    checks('*', []);
    for (let i = 1; i < CI_GRACE_POLLS; i++) reconcile(d);
    expect(reconcile(d)).toMatchObject({ outcome: 'none', action: 'escalate' });
    expect(job(d).stage).toBe('needs-human');
    expect(ghCalls('ready')).toHaveLength(0);
  });

  it('a verdict for another head is outdated, and a human merge before review escalates', () => {
    const c = toPreReviewCi();
    checks('*', [run('test', 'success')]);
    commitFile(c.wt, 'src/moved.ts', '// moved on\n');
    expect(reconcile(c)).toMatchObject({ outcome: 'outdated', action: 'escalate' });
    expect(job(c).stage).toBe('needs-human');

    const d = toPreReviewCi();
    const st = shim.read();
    const i = st.prs.length - 1;
    st.prs[i] = { ...st.prs[i], state: 'MERGED' };
    shim.write({ prs: st.prs });
    const r = reconcile(d);
    expect(r).toMatchObject({ action: 'escalate' });
    expect(r.reason).toContain('PR merged by a human');
    expect(r.reason).toContain('No DECISION: APPROVE');
    expect(job(d)).toMatchObject({ stage: 'needs-human', returnStage: 'ci' });
  });
});
