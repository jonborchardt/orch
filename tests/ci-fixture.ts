/**
 * Shared setup for the ci-stage test files: a stateful `gh` shim, a temporary store, and a policy
 * repository with a local bare origin, fresh for every test (Vitest loads this module once per test
 * file, so files running in parallel never share it). Split out so the slow ci-stage scenarios can
 * run as several files in parallel instead of one long serial file.
 */
import { beforeEach, expect } from 'vitest';
import { reconcileCi } from '../src/ops/github.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import { add, approve, type Ctx, deliverPr, go, passRound, simplify, verify } from './drive.ts';
import {
  commitFile,
  fixture,
  type GhShim,
  gitIn,
  type ShimCheckRun,
  type TempStore,
  useJobRepo,
} from './helpers.ts';

export let store: TempStore;
export let clone: string;
export let bare: string;
export let shim: GhShim;

useJobRepo({ shim: 'acme/alpha', policy: true }, (s) => ({ store, clone, bare, shim } = s));
beforeEach(() => {
  // GitHub knows the pushed head: the shim reads PR heads from the local origin.
  shim.write({ bare });
});

let nextId = 100;
export function run(
  name: string,
  conclusion: string | null,
  status = 'completed',
  app = 'github-actions',
): ShimCheckRun {
  nextId += 1;
  return {
    id: nextId,
    name,
    status,
    conclusion,
    html_url: `https://github.com/acme/alpha/actions/runs/1/job/${String(nextId)}`,
    app: { slug: app },
  };
}

/** Check runs GitHub reports for `sha` (`*` for every commit). */
export function checks(sha: string, runs: ShimCheckRun[]): void {
  shim.write({ checkRuns: { ...(shim.read().checkRuns ?? {}), [sha]: runs } });
}

export const reconcile = (c: Ctx) => reconcileCi(store, c.id, { token: c.token });
export const job = (c: Ctx) => getJob(store.db, c.id);
export const observed = (c: Ctx) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type === 'ci.observed');
export const eventTypes = (c: Ctx) => listEvents(store.db, c.id, 1000).map((e) => e.type);

/** The base branch moves on origin: one commit on the clone's main, pushed. */
export function advanceBase(file = 'docs/notes.md', body = 'upstream\n'): void {
  commitFile(clone, file, body, `base: ${file}`);
  gitIn(clone, 'push', '-q', 'origin', 'main');
}
export const ghCalls = (sub: string) =>
  shim.read().calls.filter((x) => x[0] === 'pr' && x[1] === sub);

/** The builder's repair after a CI rework: commit, verify, build.md, review, approve, push. */
export function repair(c: Ctx, file: string): string {
  expect(job(c).stage).toBe('build');
  go(store, c, 'start');
  const sha = commitFile(c.wt, file, `// fixed ${file}\n`, `fix ${file}`);
  verify(store, c);
  add(store, c, 'build.md', fixture('build.md'), true);
  go(store, c, 'complete');
  simplify(store, c);
  passRound(store, c);
  approve(store, c, true);
  go(store, c, 'start');
  deliverPr(store, c);
  go(store, c, 'start');
  return sha;
}
