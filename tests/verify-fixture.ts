/**
 * Shared setup for the verify test files, fresh for every test. Vitest loads this module once
 * per test file, so files running in parallel never share it; split out so a long serial file can
 * run as two files in parallel.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach } from 'vitest';
import { type Store } from '../src/storage/client.ts';
import { add, type Ctx, go, makePolicyRepo } from './drive.ts';
import { commitFile, gitIn, type TempStore, tempStore } from './helpers.ts';

export let store: TempStore;
export let clone: string;
export let bare: string;
export const extra: string[] = [];

beforeEach(() => {
  store = tempStore();
  ({ clone, bare } = makePolicyRepo());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare, ...extra.splice(0)]) rmSync(d, { recursive: true, force: true });
});

export function policyWith(commands: Record<string, unknown>[]): string {
  return JSON.stringify({ verification: { commands } }, null, 2) + '\n';
}

/** Replace the policy on main (the baseline) and push, before the job is created. */
export function setBaselinePolicy(commands: Record<string, unknown>[]): void {
  commitFile(clone, 'factory.json', policyWith(commands), 'policy');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

export function inBuild(c: Ctx, s: Store = store): void {
  go(s, c, 'start');
  add(s, c, 'spec.md');
  add(s, c, 'spec-review-1.md');
  go(s, c, 'complete');
  go(s, c, 'start');
}
