/**
 * maxRounds counts rejected review rounds: CI repairs and base-integration rework spend none.
 */
import { describe, expect, it } from 'vitest';
import { planJob } from '../src/ops/factory.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import {
  add,
  approve,
  consolidated,
  type Ctx,
  deliverPr,
  go,
  head,
  passRound,
  simplify,
  start,
  toReview,
  verdict,
  verify,
} from './drive.ts';
import { commitFile, fixture, gitIn } from './helpers.ts';
import { store, clone, run, checks, reconcile, job } from './ci-fixture.ts';

describe('review budget: maxRounds counts rejected reviews, not passes through build', () => {
  function changesRound(c: Ctx): void {
    go(store, c, 'start');
    verdict(store, c, 'security');
    verdict(store, c, 'correctness', 'CHANGES');
    verdict(store, c, 'code-quality');
    add(store, c, `round-${String(job(c).round)}/consolidated.md`, consolidated(store, c, '1'));
    go(store, c, 'complete');
  }
  function rebuild(c: Ctx, file: string): void {
    go(store, c, 'start');
    commitFile(c.wt, file, `// ${file}\n`, file);
    verify(store, c);
    add(store, c, 'build.md', fixture('build.md'), true);
    go(store, c, 'complete');
    simplify(store, c);
  }

  it('a CI repair does not spend a rejection: CHANGES, PASS, CI failure, CHANGES goes back to build', () => {
    const c = start(store, clone);
    toReview(store, c);
    changesRound(c); // rejection 1
    rebuild(c, 'src/r2.ts');
    passRound(store, c);
    approve(store, c);
    go(store, c, 'start');
    deliverPr(store, c);
    go(store, c, 'start');
    checks(head(c.wt), [run('test', 'failure')]);
    expect(reconcile(c).action).toBe('rework');
    rebuild(c, 'src/fix.ts');
    changesRound(c); // rejection 2, in round 3
    expect(job(c)).toMatchObject({ stage: 'build', round: 3, ciRepairs: 1, maxRounds: 3 });
    expect(planJob(store, c.id).stage).toBe('build');
    rebuild(c, 'src/fix2.ts');
    expect(planJob(store, c.id).reason).toContain('2 of 3 rejections used');
    changesRound(c); // rejection 3: the budget is spent
    expect(job(c)).toMatchObject({ stage: 'needs-human', round: 4 });
    expect(planJob(store, c.id).blockedReason).toBe('max review rounds reached');
  });

  it('a base-integration rework does not spend a rejection either', () => {
    const c = start(store, clone);
    toReview(store, c, 'src/app.ts'); // the job edits src/app.ts
    changesRound(c);
    rebuild(c, 'src/r2.ts');
    passRound(store, c);
    approve(store, c);
    go(store, c, 'start');
    // The base edits the same file: integrating in the pr stage conflicts and sends the job to build.
    commitFile(clone, 'src/app.ts', 'export const app = 2;\n', 'base edits app');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.next).toBe('rework');
    go(store, c, 'start');
    gitIn(
      c.wt,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'merge',
      '-q',
      '-X',
      'ours',
      '--no-edit',
      'origin/main',
    );
    verify(store, c);
    add(store, c, 'build.md', fixture('build.md'), true);
    go(store, c, 'complete');
    simplify(store, c);
    changesRound(c);
    expect(job(c)).toMatchObject({ stage: 'build', round: 3, ciRepairs: 0 });
  });
});
