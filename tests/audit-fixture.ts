/**
 * Shared setup for the audit test files, fresh for every test. Vitest loads this module once
 * per test file, so files running in parallel never share it; split out so a long serial file can
 * run as two files in parallel.
 */
import * as drive from './drive.ts';
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { transitionJob } from '../src/storage/jobs.ts';
import { type Ctx } from './drive.ts';
import { type GhShim, ghShim, makeRepoWithOrigin, type TempStore, tempStore } from './helpers.ts';

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

// The drivers from tests/drive.ts, bound to this file's store and clone.
export const start = (title?: string) => drive.start(store, clone, title);
export const go = (c: Ctx, action: Parameters<typeof transitionJob>[2], reason?: string) =>
  drive.go(store, c, action, reason);
export const add = (c: Ctx, rel: string, body?: string, replace?: boolean) => {
  // Code evidence is verified first, as the builder and approver do (same refusal on a dirty tree).
  if (rel === 'build.md' || rel === 'decision.md') drive.verify(store, c);
  return drive.add(store, c, rel, body, replace);
};
export const verdict = (c: Ctx, reviewer: string, v?: 'PASS' | 'CHANGES') =>
  drive.verdict(store, c, reviewer, v);
export const toReview = (c: Ctx) => {
  drive.toReview(store, c);
};
export const passRound = (c: Ctx, blocking?: string) => {
  drive.passRound(store, c, blocking);
};
export const toPr = (c: Ctx) => {
  drive.toPr(store, c);
};
