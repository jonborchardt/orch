/**
 * Drive a factory job through its stages the way the CLI does (through src/ops/gates.ts and
 * src/ops/verify.ts), against a temporary repository that carries a real factory.json policy.
 * Shared by the Phase 5B test files.
 */
import { join } from 'node:path';

import { planJob, startJob } from '../src/ops/factory.ts';
import { addArtifact, recordVerdict, transitionGuarded } from '../src/ops/gates.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { verifyJob } from '../src/ops/verify.ts';
import type { Store } from '../src/storage/client.ts';
import { getJob, transitionJob } from '../src/storage/jobs.ts';
import { commitFile, fixture, gitIn, makeRepoWithOrigin, writeArtifact } from './helpers.ts';

/** `check.js` exits 1 when marker.txt contains BREAK; the policy runs it with node. */
export const CHECK_JS =
  "const fs = require('node:fs');\n" +
  "const t = fs.readFileSync('marker.txt', 'utf8');\n" +
  "if (t.includes('BREAK')) { console.error('marker broken'); process.exit(1); }\n" +
  "console.log('OK');\n";

export const POLICY = {
  verification: { commands: [{ id: 'check', command: 'node', args: ['check.js'] }] },
};

/** A clone with origin whose main branch carries check.js, marker.txt, and factory.json. */
export function makePolicyRepo(
  originUrl = 'git@github.com:acme/alpha.git',
  policy: unknown = POLICY,
): { clone: string; bare: string } {
  const r = makeRepoWithOrigin(originUrl);
  commitFile(r.clone, 'check.js', CHECK_JS);
  commitFile(r.clone, 'marker.txt', 'fine\n');
  commitFile(r.clone, 'src/app.ts', 'export const app = 1;\n');
  if (policy !== null) {
    commitFile(r.clone, 'factory.json', JSON.stringify(policy, null, 2) + '\n');
  } else {
    gitIn(r.clone, 'rm', '-q', 'factory.json');
    gitIn(r.clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'no policy');
  }
  gitIn(r.clone, 'push', '-q', 'origin', 'main');
  return r;
}

export interface Ctx {
  id: string;
  token: string;
  dir: string;
  wt: string;
}

export const SESSION = 'claude-20261113-1200-5b5b';

export function start(store: Store, clone: string, title = 'Add CSV export'): Ctx {
  const r = startJob(store, { title, description: 'Test request', session: SESSION, cwd: clone });
  return { id: r.job.id, token: r.token, dir: r.plan.artifactDir, wt: r.job.worktreePath ?? '' };
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

/** Consolidated findings that name whatever the plan currently flags as sensitive. */
export function consolidated(store: Store, c: Ctx, blocking = '0'): string {
  const s = planJob(store, c.id).sensitive;
  const paths = s?.changes.map((x) => x.path) ?? [];
  const rel = `round-${String(getJob(store.db, c.id).round)}/consolidated.md`;
  return fixture(rel, blocking).replace(
    '\nBLOCKING:',
    `\n## Sensitive changes\n\n${paths.length ? paths.map((p) => `- ${p}`).join('\n') : 'None'}\n\nBLOCKING:`,
  );
}

export function prBody(store: Store, c: Ctx): string {
  const s = planJob(store, c.id).sensitive;
  const paths = s?.changes.map((x) => x.path) ?? [];
  return (
    fixture('pr.md') +
    `\n## Sensitive changes\n\n${paths.length ? paths.map((p) => `- ${p}`).join('\n') : 'None'}\n`
  );
}

/** spec done; one commit; verified; build.md registered; build completed: review pending. */
export function toReview(store: Store, c: Ctx, file = 'src/export.ts'): void {
  go(store, c, 'start');
  add(store, c, 'spec.md');
  go(store, c, 'complete');
  go(store, c, 'start');
  commitFile(c.wt, file, `// ${file}\n`);
  verify(store, c);
  add(store, c, 'build.md');
  go(store, c, 'complete');
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
