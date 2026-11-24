/**
 * `verification.authority: "ci"`: the base moves while the job waits in `pr`, after simplify. A
 * clean base merge does not invalidate simplify.md for the job's own changes, so review completes
 * for the merged head; a merge with edits inside it is new code and review is refused (ticket 0131).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { findArtifact } from '../src/storage/artifacts.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  add,
  type Ctx,
  deliverPr,
  go,
  head,
  start,
  toReview,
  useCiAuthority,
  verdict,
  verify,
} from './drive.ts';
import { commitFile, gitIn } from './helpers.ts';
import { checks, clone, job, reconcile, run, store } from './ci-fixture.ts';

/** A ci-authority job through build and simplify, in pr, running; returns simplify.md's head. */
function toPr(): { c: Ctx; simplified: string } {
  useCiAuthority(clone);
  const c = start(store, clone);
  toReview(store, c);
  expect(job(c)).toMatchObject({ stage: 'pr', status: 'pending' });
  go(store, c, 'start');
  return { c, simplified: head(c.wt) };
}

function advanceBase(): void {
  commitFile(clone, 'docs/notes.md', 'upstream\n', 'base: notes');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

/** Verify, the pre-review pr pass, CI passing for HEAD: the job is in review, running, verdicts in. */
function preReviewToVerdicts(c: Ctx): void {
  expect(verify(store, c).status).toBe('passed');
  deliverPr(store, c);
  go(store, c, 'start');
  checks(head(c.wt), [run('test', 'success')]);
  expect(reconcile(c)).toMatchObject({ outcome: 'passing', action: 'complete' });
  expect(job(c)).toMatchObject({ stage: 'review', ciHead: head(c.wt) });
  go(store, c, 'start');
  for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
  add(store, c, 'round-1/consolidated.md');
}

const eventTypes = (c: Ctx) => listEvents(store.db, c.id, 1000).map((e) => e.type);

describe('authority ci: a base merge between simplify and review', () => {
  it('a clean base merge in pr keeps simplify.md valid: review completes to approve', () => {
    const { c, simplified } = toPr();
    advanceBase();
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration).toMatchObject({ status: 'merged', material: [] });
    expect(r.next).toBe('verify');
    expect(head(c.wt)).not.toBe(simplified);
    preReviewToVerdicts(c);
    expect(findArtifact(store.db, c.id, 'round-1/simplify.md')?.head).toBe(simplified);
    expect(go(store, c, 'complete').stage).toBe('approve');
    expect(eventTypes(c)).not.toContain('job.blocked');
    expect(eventTypes(c)).not.toContain('job.reworked');
  });

  it('a merge with an edit inside it is new code: review complete is refused', () => {
    const { c, simplified } = toPr();
    advanceBase();
    // Someone merges by hand and slips an edit into the merge commit.
    gitIn(c.wt, 'merge', '--no-commit', '--no-ff', 'origin/main');
    writeFileSync(join(c.wt, 'src', 'app.ts'), 'export const app = 99; // smuggled\n');
    gitIn(c.wt, 'add', '-A');
    gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'merge with edit');
    const merge = head(c.wt);
    expect(merge).not.toBe(simplified);
    preReviewToVerdicts(c);
    let err: unknown;
    try {
      go(store, c, 'complete');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain(`${merge.slice(0, 7)}: src/app.ts`);
    expect((err as Error).message).toMatch(/new code/);
    expect(job(c).stage).toBe('review');
  });
});
