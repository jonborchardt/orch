/**
 * Shared setup for the factory test files, fresh for every test. Vitest loads this module once
 * per test file, so files running in parallel never share it; split out so a long serial file can
 * run as two files in parallel.
 */
import { expect } from 'vitest';
import { addArtifact, recordVerdict } from '../src/ops/gates.ts';
import { verifyJob } from '../src/ops/verify.ts';
import { checkReadonly, type Plan, planJob } from '../src/ops/factory.ts';
import { getJob, transitionJob } from '../src/storage/jobs.ts';
import * as drive from './drive.ts';
import { fixture, type GhShim, type TempStore, useJobRepo, writeArtifact } from './helpers.ts';

export let store: TempStore;
export let clone: string;
export let bare: string;
export let shim: GhShim;
export const { extra } = useJobRepo(
  { shim: 'acme/alpha' },
  (s) => ({ store, clone, bare, shim } = s),
);

export { SESSION } from './drive.ts';

export type Ctx = drive.Ctx & { plan: Plan };

/** `orch factory start` as the skill runs it. */
export const start = (title?: string, repoPath = clone, maxRounds?: number): Ctx =>
  drive.start(store, repoPath, title, maxRounds);

export const next = (id: string, ui?: boolean) => planJob(store, id, { ui });
export const go = (c: Ctx, action: Parameters<typeof transitionJob>[2], reason?: string) =>
  drive.go(store, c, action, reason);

/** Fixture subagent: writes a valid artifact, registers it, completes the stage. */
export function runStage(c: Ctx, artifact: string, body = fixture(artifact), replace = false) {
  if (getJob(store.db, c.id).status === 'pending') go(c, 'start');
  // The builder and approver verify the commit they describe before registering their artifact.
  if (artifact === 'build.md' || artifact === 'decision.md') {
    verifyJob(store, c.id, { token: c.token });
  }
  writeArtifact(c.dir, artifact, body);
  addArtifact(store, c.id, artifact, { token: c.token, replace });
  // The spec stage completes only after the challenger's PASS for this spec.md.
  if (artifact === 'spec.md') {
    writeArtifact(c.dir, 'spec-review-1.md');
    addArtifact(store, c.id, 'spec-review-1.md', { token: c.token, replace });
  }
  const done = go(c, 'complete');
  // Every build is followed by a simplify pass; this one changes nothing.
  return artifact === 'build.md' ? simplifyStage(c) : done;
}

/** Fixture simplify pass with no changes: findings, the builder's record, complete. */
export function simplifyStage(c: Ctx) {
  const plan = next(c.id);
  expect(plan.stage).toBe('simplify');
  go(c, 'start');
  for (const a of plan.agents) {
    writeArtifact(c.dir, a.artifact);
    addArtifact(store, c.id, a.artifact, { token: c.token });
  }
  return go(c, 'complete');
}

/** Fixture review round: every listed reviewer gets the verdict given; consolidation follows. */
export function reviewRound(c: Ctx, verdicts: Record<string, 'PASS' | 'CHANGES'>, blocking = 0) {
  const plan = next(c.id);
  expect(plan.stage).toBe('review');
  if (plan.status === 'pending') go(c, 'start');
  const round = plan.round;
  for (const r of plan.agents) recordVerdict(store, c.id, { token: c.token, reviewer: r.role });
  const fp = next(c.id).worktree?.fingerprint ?? '';
  for (const r of plan.agents) {
    const v = verdicts[r.role] ?? 'PASS';
    writeArtifact(c.dir, r.artifact, fixture(r.artifact, v));
    recordVerdict(store, c.id, {
      token: c.token,
      reviewer: r.role,
      verdict: v === 'PASS' ? 'pass' : 'changes',
      summary: `${r.role} says ${v}`,
    });
  }
  checkReadonly(store, c.id, fp);
  const consolidated = `round-${String(round)}/consolidated.md`;
  writeArtifact(c.dir, consolidated, fixture(consolidated, String(blocking)));
  addArtifact(store, c.id, consolidated, { token: c.token });
  return go(c, 'complete');
}
