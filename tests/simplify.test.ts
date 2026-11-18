/**
 * The simplify stage between build and review: its record is code evidence bound to a verified
 * HEAD, review verdicts must describe that HEAD, and rounds without one fall back to build.md.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planJob } from '../src/ops/factory.ts';
import { transitionGuarded } from '../src/ops/gates.ts';
import { getJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import {
  add,
  consolidated,
  type Ctx,
  go,
  head,
  makePolicyRepo,
  passRound,
  passSpec,
  simplify,
  start,
  toReview,
  verdict,
  verify,
} from './drive.ts';
import { commitFile, fixture, gitIn, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
beforeEach(() => {
  store = tempStore();
  ({ clone, bare } = makePolicyRepo());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
});

/** spec passed, one commit built and verified, build completed: simplify pending, round 1. */
function toSimplify(c: Ctx): void {
  passSpec(store, c);
  go(store, c, 'start');
  commitFile(c.wt, 'src/export.ts', '// export\n');
  verify(store, c);
  add(store, c, 'build.md');
  go(store, c, 'complete');
}

/** A review round with every always-on verdict PASS, consolidated, then complete. */
function reviewRound(c: Ctx): void {
  go(store, c, 'start');
  for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
  const round = getJob(store.db, c.id).round;
  add(store, c, `round-${String(round)}/consolidated.md`, consolidated(store, c));
  go(store, c, 'complete');
}

describe('simplify stage gates', () => {
  it('plans the simplifier then the builder, both registrations, verify, and complete', () => {
    const c = start(store, clone);
    toSimplify(c);
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'simplify', round: 1 });
    const plan = planJob(store, c.id);
    expect(plan.agents.map((a) => [a.agent, a.artifact])).toEqual([
      ['factory-simplifier', 'round-1/simplify-review.md'],
      ['factory-builder', 'round-1/simplify.md'],
    ]);
    expect(plan.requiredArtifacts).toEqual(['round-1/simplify-review.md', 'round-1/simplify.md']);
    const cmds = plan.commands.map((x) => x.replace(c.id, '<id>'));
    expect(cmds).toEqual([
      'orch job transition <id> start --token <token>',
      'orch job artifact add <id> round-1/simplify-review.md --token <token>',
      'orch verify <id> --token <token>',
      'orch job artifact add <id> round-1/simplify.md --token <token>',
      'orch job transition <id> complete --token <token>',
    ]);
  });

  it('a no-change simplify completes on the build verification, with no new commit', () => {
    const c = start(store, clone);
    toSimplify(c);
    const built = head(c.wt);
    simplify(store, c);
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'review', status: 'pending', round: 1 });
    expect(head(c.wt)).toBe(built);
    expect(planJob(store, c.id).verification?.valid).toBe(true);
  });

  it('refuses simplify.md from a dirty worktree, and completion past or without its verification', () => {
    const c = start(store, clone);
    toSimplify(c);
    go(store, c, 'start');
    add(store, c, 'round-1/simplify-review.md');
    writeFileSync(join(c.wt, 'src', 'export.ts'), '// half applied\n');
    expect(() => add(store, c, 'round-1/simplify.md')).toThrow(/committed state/);
    gitIn(c.wt, 'checkout', '--', 'src/export.ts');
    // Registered, then HEAD moves: the record no longer describes the code.
    add(store, c, 'round-1/simplify.md');
    commitFile(c.wt, 'src/export.ts', '// simpler\n', 'simplify');
    expect(() => go(store, c, 'complete')).toThrow(/round-1\/simplify.md describe/);
    // Re-registered at the new HEAD, but that HEAD was never verified.
    add(store, c, 'round-1/simplify.md', fixture('round-1/simplify.md'), true);
    expect(() => go(store, c, 'complete')).toThrow(/No valid verification run/);
    verify(store, c);
    go(store, c, 'complete');
    expect(getJob(store.db, c.id).stage).toBe('review');
  });

  it('after a simplify commit, verdicts must describe that commit, not the build', () => {
    const c = start(store, clone);
    toSimplify(c);
    const built = head(c.wt);
    go(store, c, 'start');
    add(store, c, 'round-1/simplify-review.md');
    commitFile(c.wt, 'src/export.ts', '// simpler\n', 'simplify');
    verify(store, c);
    add(store, c, 'round-1/simplify.md');
    go(store, c, 'complete');
    const simplified = head(c.wt);
    const branch = gitIn(c.wt, 'rev-parse', '--abbrev-ref', 'HEAD');
    // Reviewers judging the build commit are refused (the temp branch is pointed back at it).
    gitIn(c.wt, 'checkout', '-q', '-B', branch, built);
    go(store, c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    add(store, c, 'round-1/consolidated.md', consolidated(store, c));
    expect(() => go(store, c, 'complete')).toThrow(/round-1\/simplify.md describes/);
    // Re-recorded on the simplify commit, the same round completes.
    gitIn(c.wt, 'checkout', '-q', '-B', branch, simplified);
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    go(store, c, 'complete');
    expect(getJob(store.db, c.id).stage).toBe('approve');
  });
});

describe('rounds without a simplify record fall back to build.md', () => {
  it('a legacy job already in review completes against build.md', () => {
    const c = start(store, clone);
    toSimplify(c);
    // Built before the stage existed: the job went straight from build to review.
    store.db.update(jobs).set({ stage: 'review' }).where(eq(jobs.id, c.id)).run();
    reviewRound(c);
    expect(getJob(store.db, c.id).stage).toBe('approve');
  });

  it('resume --to review from needs-human, with unchanged code, reviews the build.md commit', () => {
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'escalate', 'human look');
    transitionGuarded(store, c.id, 'resume', { token: c.token, to: 'review' });
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'review', round: 2 });
    reviewRound(c);
    expect(getJob(store.db, c.id).stage).toBe('approve');
  });

  it('a rework round ignores the stale simplify.md of the earlier round', () => {
    const c = start(store, clone);
    toReview(store, c);
    passRound(store, c, '1'); // blocking finding: back to build
    go(store, c, 'start');
    commitFile(c.wt, 'src/r2.ts', '// r2\n', 'r2');
    verify(store, c);
    add(store, c, 'build.md', fixture('build.md'), true);
    go(store, c, 'complete');
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'simplify', round: 2 });
    // A human skips this round's simplify; round-1/simplify.md describes an older commit.
    go(store, c, 'escalate', 'skip simplify');
    transitionGuarded(store, c.id, 'resume', { token: c.token, to: 'review' });
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'review', round: 3 });
    reviewRound(c);
    expect(getJob(store.db, c.id).stage).toBe('approve');
  });

  it('resume --to simplify opens a new round with its own records', () => {
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'escalate', 'simplify again');
    transitionGuarded(store, c.id, 'resume', { token: c.token, to: 'simplify' });
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'simplify', round: 2 });
    simplify(store, c);
    reviewRound(c);
    expect(getJob(store.db, c.id).stage).toBe('approve');
  });
});
