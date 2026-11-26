/**
 * `verification.authority: "ci"`: the base moves during review or approve, after the pre-review CI
 * pass. One clean recorded integration carries that CI pass to review and approve completion, and
 * the pr/ci pass after approval checks the merge commit itself; an edited merge still reworks and
 * a second integration still needs a person (ticket 0173).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  add,
  type Ctx,
  deliverPr,
  go,
  head,
  passRound,
  start,
  toReview,
  useCiAuthority,
  verify,
} from './drive.ts';
import { commitFile, gitIn } from './helpers.ts';
import { checks, clone, job, reconcile, run, store } from './ci-fixture.ts';

/** A ci-authority job whose pre-review pr/ci pass passed: in review, pending. */
function toReviewAfterCi(): Ctx {
  useCiAuthority(clone);
  const c = start(store, clone);
  toReview(store, c);
  go(store, c, 'start');
  deliverPr(store, c);
  go(store, c, 'start');
  checks(head(c.wt), [run('test', 'success')]);
  expect(reconcile(c)).toMatchObject({ outcome: 'passing', action: 'complete' });
  expect(job(c)).toMatchObject({ stage: 'review', ciHead: head(c.wt) });
  return c;
}

/** As above, review passed: in approve, running. */
function toApprove(): Ctx {
  const c = toReviewAfterCi();
  passRound(store, c);
  go(store, c, 'start');
  expect(job(c)).toMatchObject({ stage: 'approve', status: 'running' });
  return c;
}

function advanceBase(file = 'docs/notes.md', body = 'upstream\n'): void {
  commitFile(clone, file, body, `base: ${file}`);
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

/** One clean recorded integration; the job stays where it is. Returns the merge commit. */
function integrateClean(c: Ctx): string {
  const stage = job(c).stage;
  const r = integrateBase(store, c.id, { token: c.token });
  expect(r.integration).toMatchObject({ status: 'merged', material: [] });
  expect(job(c).stage).toBe(stage);
  return head(c.wt);
}

/** Verify HEAD, decision.md APPROVE, complete approve, then push and the PR: in ci, running. */
function approveAndDeliver(c: Ctx): void {
  expect(verify(store, c).status).toBe('passed');
  add(store, c, 'decision.md');
  expect(go(store, c, 'complete').stage).toBe('pr');
  go(store, c, 'start');
  deliverPr(store, c);
  go(store, c, 'start');
}

const events = (c: Ctx) => listEvents(store.db, c.id, 1000);
const eventTypes = (c: Ctx) => events(c).map((e) => e.type);

function expectCompletedAt(c: Ctx, merge: string): void {
  checks(merge, [run('test', 'success')]);
  expect(reconcile(c)).toMatchObject({ outcome: 'passing', action: 'complete' });
  expect(job(c)).toMatchObject({ stage: 'completed', ciStatus: 'passing', ciHead: merge });
  expect(eventTypes(c)).not.toContain('job.blocked');
}

describe('authority ci: a clean base integration after the pre-review CI pass', () => {
  it('in approve: approval completes and the pr/ci pass for the merge commit completes the job', () => {
    const c = toApprove();
    const passed = head(c.wt);
    advanceBase();
    const merge = integrateClean(c);
    expect(merge).not.toBe(passed);
    expect(job(c).ciHead).toBe(passed);
    approveAndDeliver(c);
    expectCompletedAt(c, merge);
  });

  it('in review: review completes for the merge commit and the job completes the same way', () => {
    const c = toReviewAfterCi();
    advanceBase();
    const merge = integrateClean(c);
    expect(verify(store, c).status).toBe('passed');
    passRound(store, c);
    expect(job(c).stage).toBe('approve');
    go(store, c, 'start');
    approveAndDeliver(c);
    expectCompletedAt(c, merge);
  });

  it('a merge with an edit inside it still reworks to build', () => {
    const c = toApprove();
    // Both sides add the same file; a union merge keeps both, which matches neither parent.
    const common = gitIn(c.wt, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    writeFileSync(join(common, 'info', 'attributes'), 'src/export.ts merge=union\n');
    advanceBase('src/export.ts', '// from the base\n');
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration).toMatchObject({ status: 'merged', material: ['src/export.ts'] });
    expect(r.next).toBe('rework');
    expect(job(c)).toMatchObject({ stage: 'build', status: 'pending' });
    const reworked = events(c).filter((e) => e.type === 'job.reworked');
    expect(reworked.at(-1)?.payload).toMatchObject({ from: 'approve', integration: true });
  });

  it('a second integration before CI re-ran is not carried: approve is refused as before', () => {
    const c = toApprove();
    advanceBase();
    integrateClean(c);
    advanceBase('docs/more.md');
    integrateClean(c);
    expect(verify(store, c).status).toBe('passed');
    add(store, c, 'decision.md');
    let err: unknown;
    try {
      go(store, c, 'complete');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/completing approve is refused: .*CI/);
    expect((err as Error).message).toContain(`orch factory resume ${c.id} --to pr`);
    expect(job(c).stage).toBe('approve');
  });

  it('CI failing on the merge commit takes the CI repair path', () => {
    const c = toApprove();
    advanceBase();
    const merge = integrateClean(c);
    approveAndDeliver(c);
    checks(merge, [run('test', 'failure')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'failing', action: 'rework' });
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 1, maxCiRepairs: 2 });
  });
});
