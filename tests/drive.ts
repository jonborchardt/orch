/**
 * Drive a factory job through its stages the way the CLI does (through src/ops/gates.ts and
 * src/ops/verify.ts), against a temporary repository that carries a real factory.json policy.
 * Shared by the Phase 5B test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dispatchJob } from '../src/ops/dispatch.ts';
import { type Plan, planJob, resumeFactoryJob, startJob } from '../src/ops/factory.ts';
import { addArtifact, recordVerdict, transitionGuarded } from '../src/ops/gates.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { verifyJob } from '../src/ops/verify.ts';
import type { Store } from '../src/storage/client.ts';
import { getJob, transitionJob } from '../src/storage/jobs.ts';
import { commitFile, fixture, gitIn, POLICY, writeArtifact } from './helpers.ts';

export { CHECK_JS, makePolicyRepo, POLICY } from './helpers.ts';

/** POLICY with GitHub CI as the authoritative test gate. */
export const CI_POLICY = {
  verification: { authority: 'ci', commands: POLICY.verification.commands },
};

/** Make CI_POLICY the baseline on main (before the job starts). */
export function useCiAuthority(clone: string): void {
  const text = JSON.stringify(CI_POLICY, null, 2) + '\n';
  if (readFileSync(join(clone, 'factory.json'), 'utf8') === text) return;
  commitFile(clone, 'factory.json', text, 'authority ci');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

export interface Ctx {
  id: string;
  token: string;
  dir: string;
  wt: string;
}

export const SESSION = 'claude-20261113-1200-5b5b';

export function start(
  store: Store,
  clone: string,
  title = 'Add CSV export',
  maxRounds?: number,
): Ctx & { plan: Plan } {
  const r = startJob(store, {
    title,
    description: 'Test request',
    session: SESSION,
    cwd: clone,
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

/**
 * A fast job (what `orch do --fast` dispatches), claimed with a worktree: in build, pending. The
 * Ctx and every helper below work for it as for a full job.
 */
export function startFast(store: Store, clone: string, ticket?: number): Ctx {
  const { job } = dispatchJob(store, {
    ...(ticket === undefined ? { title: 'Fix a typo', description: 'Test request' } : { ticket }),
    session: SESSION,
    cwd: clone,
    mode: 'fast',
  });
  const r = resumeFactoryJob(store, job.id, { session: SESSION });
  return { id: job.id, token: r.token, dir: r.plan.artifactDir, wt: r.job.worktreePath ?? '' };
}

/** A fast build: one commit, verified, build.md registered, completed: pr pending. */
export function fastBuild(store: Store, c: Ctx, file = 'src/fix.ts', replace = false): string {
  go(store, c, 'start');
  const sha = commitFile(c.wt, file, `// ${file}\n`);
  verify(store, c);
  add(store, c, 'build.md', fixture('build.md'), replace);
  go(store, c, 'complete');
  return sha;
}

export const go = (
  store: Store,
  c: Ctx,
  action: Parameters<typeof transitionJob>[2],
  reason?: string,
) => transitionGuarded(store, c.id, action, { token: c.token, reason });

export const add = (store: Store, c: Ctx, rel: string, body = fixture(rel), replace = false) => {
  writeArtifact(c.dir, rel, body);
  return addArtifact(store, c.id, rel, { token: c.token, replace });
};

export const verdict = (store: Store, c: Ctx, reviewer: string, v: 'PASS' | 'CHANGES' = 'PASS') => {
  const rel = `round-${String(getJob(store.db, c.id).round)}/review-${reviewer}.md`;
  writeArtifact(c.dir, rel, fixture(rel, v));
  return recordVerdict(store, c.id, {
    token: c.token,
    reviewer,
    verdict: v === 'PASS' ? 'pass' : 'changes',
  });
};

export const verify = (store: Store, c: Ctx) => verifyJob(store, c.id, { token: c.token });

export const head = (dir: string) => gitIn(dir, 'rev-parse', 'HEAD');

/** The `## Sensitive changes` section naming whatever the plan currently flags as sensitive. */
function sensitiveSection(store: Store, c: Ctx): string {
  const paths = planJob(store, c.id).sensitive?.changes.map((x) => x.path) ?? [];
  return `\n## Sensitive changes\n\n${paths.length ? paths.map((p) => `- ${p}`).join('\n') : 'None'}\n`;
}

/** Consolidated findings that name whatever the plan currently flags as sensitive. */
export function consolidated(store: Store, c: Ctx, blocking = '0'): string {
  const rel = `round-${String(getJob(store.db, c.id).round)}/consolidated.md`;
  return fixture(rel, blocking).replace('\nBLOCKING:', `${sensitiveSection(store, c)}\nBLOCKING:`);
}

export function prBody(store: Store, c: Ctx): string {
  return fixture('pr.md') + sensitiveSection(store, c);
}

/** spec written, challenged with a PASS, completed: build pending. */
export function passSpec(store: Store, c: Ctx): void {
  go(store, c, 'start');
  add(store, c, 'spec.md');
  add(store, c, 'spec-review-1.md');
  go(store, c, 'complete');
}

/** A simplify pass that changes nothing: findings and record registered, completed: review pending. */
export function simplify(store: Store, c: Ctx): void {
  const round = String(getJob(store.db, c.id).round);
  go(store, c, 'start');
  add(store, c, `round-${round}/simplify-review.md`);
  add(store, c, `round-${round}/simplify.md`);
  go(store, c, 'complete');
}

/** spec done; one commit; verified; build.md registered; build and simplify completed: review pending. */
export function toReview(store: Store, c: Ctx, file = 'src/export.ts'): void {
  passSpec(store, c);
  go(store, c, 'start');
  commitFile(c.wt, file, `// ${file}\n`);
  verify(store, c);
  add(store, c, 'build.md');
  go(store, c, 'complete');
  simplify(store, c);
}

/** One round where every always-on reviewer passes; `blocking` is the consolidated count. */
export function passRound(store: Store, c: Ctx, blocking = '0'): void {
  go(store, c, 'start');
  for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
  const round = getJob(store.db, c.id).round;
  add(store, c, `round-${String(round)}/consolidated.md`, consolidated(store, c, blocking));
  go(store, c, 'complete');
}

export function approve(store: Store, c: Ctx, replace = false): void {
  go(store, c, 'start');
  add(store, c, 'decision.md', fixture('decision.md'), replace);
  go(store, c, 'complete');
}

/** All the way to the pr stage, running. */
export function toPr(store: Store, c: Ctx): void {
  toReview(store, c);
  passRound(store, c);
  approve(store, c);
  go(store, c, 'start');
}

export const prFile = (c: Ctx) => join(c.dir, 'pr.md');

/** Push, create (or reuse) the draft PR, register pr.md, complete pr: the job is in ci, pending. */
export function deliverPr(store: Store, c: Ctx): void {
  pushBranch(store, c.id, { token: c.token });
  writeArtifact(c.dir, 'pr.md', prBody(store, c));
  ensureDraftPr(store, c.id, { token: c.token, bodyFile: prFile(c) });
  add(store, c, 'pr.md', prBody(store, c), true);
  go(store, c, 'complete');
}

/** All the way to the ci stage, running. */
export function toCi(store: Store, c: Ctx): void {
  toPr(store, c);
  deliverPr(store, c);
  go(store, c, 'start');
}
