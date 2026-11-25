/**
 * A verified merge removes the job's clean worktree (ticket 0142), the way `orch worktree remove`
 * does: the branch is kept, a dirty or broken worktree is kept and `worktree.kept` says why, and
 * the merge result never depends on it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { git } from '../src/git/run.ts';
import { mergeJob } from '../src/ops/merge.ts';
import { listEvents } from '../src/storage/events.ts';
import { type Ctx, head, start, toCi } from './drive.ts';
import { checks, clone, ghCalls, job, reconcile, run, shim, store } from './ci-fixture.ts';

const types = (c: Ctx) => listEvents(store.db, c.id, 1000).map((e) => e.type);
const kept = (c: Ctx) =>
  listEvents(store.db, c.id, 1000)
    .filter((e) => e.type === 'worktree.kept')
    .map((e) => e.payload);
const merge = (c: Ctx) => mergeJob(store, c.id, { session: 'merger', mode: 'dashboard' });

function completed(): { c: Ctx; sha: string } {
  const c = start(store, clone);
  toCi(store, c);
  const sha = head(c.wt);
  checks(sha, [run('test', 'success')]);
  expect(reconcile(c)).toMatchObject({ action: 'complete', ready: 'marked' });
  return { c, sha };
}

function mergedOnce(c: Ctx) {
  const r = merge(c);
  expect(r).toMatchObject({ outcome: 'merged', verified: true, ticket: null });
  expect(ghCalls('merge')).toHaveLength(1);
  expect(job(c)).toMatchObject({ prState: 'merged', ownerSession: null, ownerToken: null });
  return r;
}

describe('worktree after a verified merge', () => {
  it('removes a clean worktree, keeps the branch, and records worktree.removed', () => {
    const { c } = completed();
    const branch = job(c).branch ?? '';
    const r = mergedOnce(c);
    expect(r.reason.endsWith(` Removed the worktree ${c.wt}.`)).toBe(true);
    expect(existsSync(c.wt)).toBe(false);
    expect(job(c)).toMatchObject({ worktreePath: null, branch });
    expect(git(clone, 'rev-parse', '--verify', `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}/);
    const t = types(c);
    expect(t.lastIndexOf('worktree.removed')).toBeGreaterThan(t.lastIndexOf('pr.merged'));
    expect(kept(c)).toEqual([]);
  });

  it('keeps a dirty worktree and says why, and the merge still counts', () => {
    const { c } = completed();
    const file = join(c.wt, 'scratch.txt');
    writeFileSync(file, 'not committed\n');
    const r = mergedOnce(c);
    expect(existsSync(file)).toBe(true);
    expect(job(c).worktreePath).toBe(c.wt);
    expect(kept(c)).toEqual([
      { path: c.wt, reason: expect.stringMatching(/uncommitted/) as string },
    ]);
    expect(types(c)).not.toContain('worktree.removed');
    expect(r.reason).toMatch(/ Kept the worktree .*uncommitted.*\.$/);
  });

  it('keeps a path Git no longer knows as a worktree, without throwing', () => {
    const { c } = completed();
    git(clone, 'worktree', 'remove', '--force', c.wt);
    mkdirSync(c.wt, { recursive: true });
    const r = mergedOnce(c);
    expect(types(c)).toContain('pr.merged');
    expect(kept(c)).toEqual([
      { path: c.wt, reason: expect.stringMatching(/not a worktree/) as string },
    ]);
    expect(r.reason).toContain(`Kept the worktree ${c.wt}: `);
  });

  it('leaves the worktree alone after an unverified merge', () => {
    const { c } = completed();
    shim.write({ bare: undefined });
    const st = shim.read();
    st.prs[0] = {
      ...st.prs[0],
      state: 'MERGED',
      headRefOid: '0'.repeat(40),
      mergeCommit: { oid: 'c'.repeat(40) },
    };
    shim.write({ prs: st.prs });
    const r = merge(c);
    expect(r).toMatchObject({ outcome: 'already_merged', verified: false });
    expect(existsSync(c.wt)).toBe(true);
    expect(job(c).worktreePath).toBe(c.wt);
    expect(types(c)).not.toContain('worktree.removed');
    expect(kept(c)).toEqual([]);
    expect(r.reason).not.toMatch(/worktree/);
  });
});
