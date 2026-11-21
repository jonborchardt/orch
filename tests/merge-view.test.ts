/**
 * The Git tab's merged view (todo 0017): history comes from recorded evidence (the merged head and
 * the merge base of its baseline verification run), never from the current comparison with the base.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PrState } from '../src/core/workflow.ts';
import { changesBetween, commitsBetween } from '../src/git/worktree.ts';
import { detail } from '../src/server/api.ts';
import { getJob, recordMerge, recordPrState } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { type Ctx, head, start, verify } from './drive.ts';
import { commitFile, gitIn, makeRepoWithOrigin, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
beforeEach(() => {
  store = tempStore();
  ({ clone, bare } = makeRepoWithOrigin());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
});

const PR = 'https://github.com/acme/alpha/pull/7';

/** A started job with two commits in its worktree and a draft PR recorded. */
function jobWithTwoCommits(): Ctx {
  const c = start(store, clone);
  commitFile(c.wt, 'src/a.ts', 'export const a = 1;\n', 'Add a');
  commitFile(c.wt, 'src/b.ts', 'export const b = 2;\n', 'Add b');
  // The PR stage is not under test here: record the PR link directly.
  store.db.update(jobs).set({ prUrl: PR, prState: 'draft' }).where(eq(jobs.id, c.id)).run();
  return c;
}

const observe = (c: Ctx, state: PrState, sha: string | null) =>
  recordPrState(store, c.id, { token: c.token }, { event: 'pr.observed', state, head: sha });

describe('commit range helpers', () => {
  it('list commits and changes between two commits, and null for an unknown commit', () => {
    const from = head(clone);
    commitFile(clone, 'x.txt', 'x\n', 'Add x');
    const to = commitFile(clone, 'y.txt', 'y\n', 'Add y');
    expect(commitsBetween(clone, from, to)?.map((c) => c.subject)).toEqual(['Add y', 'Add x']);
    expect(changesBetween(clone, from, to)).toEqual([
      { path: 'x.txt', status: 'added' },
      { path: 'y.txt', status: 'added' },
    ]);
    expect(commitsBetween(clone, to, to)).toEqual([]);
    const missing = 'f'.repeat(40);
    expect(commitsBetween(clone, missing, to)).toBeNull();
    expect(changesBetween(clone, missing, to)).toBeNull();
  });
});

describe('detail().merge', () => {
  it('is null unless merged, then reports recorded history after the base moves on (AC4, AC5)', () => {
    const c = start(store, clone);
    expect(detail(store, c.id).merge).toBeNull(); // no PR at all
    commitFile(c.wt, 'src/a.ts', 'export const a = 1;\n', 'Add a');
    commitFile(c.wt, 'src/b.ts', 'export const b = 2;\n', 'Add b');
    expect(verify(store, c).status).toBe('passed');
    store.db.update(jobs).set({ prUrl: PR, prState: 'draft' }).where(eq(jobs.id, c.id)).run();
    expect(detail(store, c.id).merge).toBeNull();
    for (const state of ['ready', 'closed'] as const) {
      observe(c, state, head(c.wt));
      expect(detail(store, c.id).merge).toBeNull();
    }

    // GitHub merges the branch, then main advances.
    const branch = getJob(store.db, c.id).branch ?? '';
    gitIn(clone, 'merge', '-q', '--no-ff', '-m', 'Merge PR', branch);
    commitFile(clone, 'later.txt', 'later\n', 'Later work on main');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const merged = head(c.wt);
    const mergeCommit = gitIn(clone, 'rev-parse', 'HEAD~1');
    recordMerge(
      store,
      c.id,
      { token: c.token },
      { head: merged, mergeCommit, verified: true, reason: null },
    );

    const d = detail(store, c.id);
    expect(d.plan?.worktree?.ahead).toBe(0);
    expect(d.merge).toEqual({
      base: 'main',
      prUrl: PR,
      head: merged,
      mergeCommit,
      verified: true,
      historyKnown: true,
      commits: [
        { sha: merged, subject: 'Add b' },
        { sha: gitIn(c.wt, 'rev-parse', 'HEAD~1'), subject: 'Add a' },
      ],
      changedFiles: ['src/a.ts', 'src/b.ts'],
      outstanding: [],
    });
  });

  it('without a baseline run the history is unknown; without a head nothing is outstanding (AC4, AC11)', () => {
    const c = jobWithTwoCommits();
    observe(c, 'merged', null);
    expect(detail(store, c.id).merge).toMatchObject({
      base: 'main',
      head: null,
      historyKnown: false,
      commits: [],
      changedFiles: [],
      outstanding: null,
    });
    observe(c, 'merged', head(c.wt));
    expect(detail(store, c.id).merge).toMatchObject({
      head: head(c.wt),
      historyKnown: false,
      commits: [],
      changedFiles: [],
      outstanding: [],
    });
  });

  it('after a squash merge, outstanding is only what the worktree added since (AC10)', () => {
    const c = jobWithTwoCommits();
    expect(verify(store, c).status).toBe('passed');
    // The same change lands on main as one new commit, not a merge of the branch.
    mkdirSync(join(clone, 'src'), { recursive: true });
    writeFileSync(join(clone, 'src', 'a.ts'), 'export const a = 1;\n');
    gitIn(clone, 'add', '--', 'src/a.ts');
    commitFile(clone, 'src/b.ts', 'export const b = 2;\n', 'Squash');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const merged = head(c.wt);
    observe(c, 'merged', merged);

    let d = detail(store, c.id);
    expect(d.plan?.worktree?.ahead).toBe(2);
    expect(d.merge?.outstanding).toEqual([]);
    expect(d.merge?.commits.map((x) => x.subject)).toEqual(['Add b', 'Add a']);

    const later = commitFile(c.wt, 'src/c.ts', 'export const c = 3;\n', 'Add c');
    d = detail(store, c.id);
    expect(d.merge?.outstanding).toEqual([{ sha: later, subject: 'Add c' }]);
  });
});
