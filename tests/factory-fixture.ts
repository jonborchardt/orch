/**
 * Shared setup for the factory test files, fresh for every test. Vitest loads this module once
 * per test file, so files running in parallel never share it; split out so a long serial file can
 * run as two files in parallel.
 */
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { addArtifact, recordVerdict, transitionGuarded } from '../src/ops/gates.ts';
import { verifyJob } from '../src/ops/verify.ts';
import { checkReadonly, type Plan, planJob, startJob } from '../src/ops/factory.ts';
import { getJob, transitionJob } from '../src/storage/jobs.ts';
import {
  fixture,
  type GhShim,
  ghShim,
  makeRepoWithOrigin,
  type TempStore,
  tempStore,
  writeArtifact,
} from './helpers.ts';

export let store: TempStore;
export let clone: string;
export let bare: string;
export let shim: GhShim;
export const extra: string[] = [];

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
  ({ clone, bare } = makeRepoWithOrigin('git@github.com:acme/alpha.git'));
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare, ...extra.splice(0)]) rmSync(d, { recursive: true, force: true });
});

export const SESSION = 'claude-20261113-0900-ab12';

export interface Ctx {
  id: string;
  token: string;
  dir: string;
  wt: string;
  plan: Plan;
}

/** `orch factory start` as the skill runs it. */
export function start(title = 'Add CSV export', repoPath = clone, maxRounds?: number): Ctx {
  const r = startJob(store, {
    title,
    description: 'Test request',
    session: SESSION,
    cwd: repoPath,
    maxRounds,
  });
  return {
    id: r.job.id,
    token: r.token,
    dir: r.plan.artifactDir,
    wt: r.job.worktreePath ?? '',
    plan: r.plan,
  };
}

export const next = (id: string, ui?: boolean) => planJob(store, id, { ui });
export const go = (c: Ctx, action: Parameters<typeof transitionJob>[2], reason?: string) =>
  transitionGuarded(store, c.id, action, { token: c.token, reason });

/** Fixture subagent: writes a valid artifact, registers it, completes the stage. */
export function runStage(c: Ctx, artifact: string, body = fixture(artifact), replace = false) {
  if (getJob(store.db, c.id).status === 'pending') go(c, 'start');
  // The builder and approver verify the commit they describe before registering their artifact.
  if (artifact === 'build.md' || artifact === 'decision.md') {
    verifyJob(store, c.id, { token: c.token });
  }
  writeArtifact(c.dir, artifact, body);
  addArtifact(store, c.id, artifact, { token: c.token, replace });
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
