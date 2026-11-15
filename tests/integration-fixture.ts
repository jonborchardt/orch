/**
 * Shared setup for the integration test files, fresh for every test. Vitest loads this module once
 * per test file, so files running in parallel never share it; split out so a long serial file can
 * run as two files in parallel.
 */
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { add, type Ctx, go, makePolicyRepo, prBody, prFile } from './drive.ts';
import {
  commitFile,
  type GhShim,
  ghShim,
  gitIn,
  type TempStore,
  tempStore,
  writeArtifact,
} from './helpers.ts';

export let store: TempStore;
export let clone: string;
export let bare: string;
export let shim: GhShim;

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
  ({ clone, bare } = makePolicyRepo());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
});

/** Advance main on origin with a commit to `file`. */
export function advanceBase(file: string, body: string): string {
  const sha = commitFile(clone, file, body, `base: ${file}`);
  gitIn(clone, 'push', '-q', 'origin', 'main');
  return sha;
}

export function deliver(c: Ctx): void {
  pushBranch(store, c.id, { token: c.token });
  writeArtifact(c.dir, 'pr.md', prBody(store, c));
  ensureDraftPr(store, c.id, { token: c.token, bodyFile: prFile(c) });
  add(store, c, 'pr.md', prBody(store, c));
  expect(go(store, c, 'complete').stage).toBe('ci');
}
