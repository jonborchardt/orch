/**
 * Ticket 0135: a re-land job's branch starts at the superseded job's branch head, so its builder
 * resolves the conflict with the base instead of re-implementing. Local bare origins only.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MergeConflictError } from '../src/core/errors.ts';
import { type Notice, type Plan, planJob } from '../src/ops/factory.ts';
import { relandJob } from '../src/ops/merge.ts';
import { createWorktree, integrateBase, showWorktree } from '../src/ops/worktree.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob } from '../src/storage/jobs.ts';
import { listIntegrations } from '../src/storage/verification.ts';
import { add, type Ctx, go, head, SESSION, start, toReview } from './drive.ts';
import {
  cleanupTempDirs,
  commitFile,
  gitIn,
  makeRepoWithOrigin,
  type TempStore,
  tempStore,
} from './helpers.ts';

let store: TempStore;
let clone: string;
beforeEach(() => {
  store = tempStore();
  clone = makeRepoWithOrigin().clone;
});
afterEach(() => {
  store.cleanup();
});
afterAll(() => {
  cleanupTempDirs();
});

const notice = (p: Plan): Notice | undefined => p.notices.find((n) => n.kind === 'base-moved');
const ancestor = (dir: string, a: string, b: string) => {
  try {
    gitIn(dir, 'merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
};

/** Job A with a commit to hello.txt, re-landed as B, and B's worktree created. */
function reland(): {
  a: Ctx;
  aHead: string;
  b: Ctx;
  from: { ref: string; sha: string } | undefined;
} {
  const a = start(store, clone);
  const aHead = commitFile(a.wt, 'hello.txt', 'from A\n');
  const created = relandJob(store, getJob(store.db, a.id), a.token, SESSION);
  const { token } = claimJob(store, created.id, { session: SESSION });
  const r = createWorktree(store, created.id, { token });
  const b = { id: created.id, token, dir: '', wt: r.job.worktreePath ?? '' };
  b.dir = planJob(store, b.id).artifactDir;
  return { a, aHead, b, from: r.from };
}

/** main gains a conflicting commit to hello.txt, pushed to origin. */
function conflictOnMain(): void {
  commitFile(clone, 'hello.txt', 'from main\n');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

describe('a re-land starts from the superseded branch', () => {
  it('seeds B at A head; integrate in spec conflicts safely; the builder merge resolves it', () => {
    const { a, aHead, b, from } = reland();
    const aBranch = getJob(store.db, a.id).branch ?? '';
    // AC1
    expect(head(b.wt)).toBe(aHead);
    expect(ancestor(b.wt, aHead, head(b.wt))).toBe(true);
    expect(from).toEqual({ ref: aBranch, sha: aHead });
    const created = listEvents(store.db, b.id, 100).find((e) => e.type === 'worktree.created');
    expect(created?.payload['from']).toEqual({ ref: aBranch, sha: aHead });

    // AC2 (a)-(c): integrate in spec throws, aborts, and records the conflict.
    conflictOnMain();
    const before = head(b.wt);
    let err: unknown;
    try {
      integrateBase(store, b.id, { token: b.token });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MergeConflictError);
    expect((err as MergeConflictError).files).toEqual(['hello.txt']);
    expect(head(b.wt)).toBe(before);
    expect(gitIn(b.wt, 'status', '--porcelain')).toBe('');
    expect(listIntegrations(store.db, b.id)[0]).toMatchObject({
      status: 'conflict',
      conflicts: ['hello.txt'],
    });

    // AC5 / AC6 in spec: the re-land wording, not "integrate before the next verify".
    go(store, b, 'start');
    const spec = planJob(store, b.id);
    const text = notice(spec)?.text ?? '';
    expect(text).toContain(a.id);
    expect(text).toContain('main');
    expect(text).toContain('in build, the builder merges');
    expect(text).toContain('Do not run `orch worktree integrate`');
    expect(text).not.toContain('before the next `orch verify`');
    for (const part of [
      a.id,
      aBranch,
      'merge',
      'main',
      'reviewed as new code',
      'conflict resolution',
    ]) {
      expect(spec.reason).toContain(part);
    }

    // In build, the same notice and note (without the spec sentence).
    add(store, b, 'spec.md');
    add(store, b, 'spec-review-1.md');
    go(store, b, 'complete');
    go(store, b, 'start');
    const build = planJob(store, b.id);
    expect(build.stage).toBe('build');
    expect(notice(build)?.text).toContain('in build, the builder merges');
    expect(notice(build)?.text).not.toContain('before the next `orch verify`');
    expect(build.reason).toContain('reviewed as new code');
    expect(build.reason).toContain(aBranch);
    expect(build.reason).not.toContain('conflict resolution');

    // AC2 (d): the builder merges the base, resolves, and commits.
    const base = showWorktree(store, b.id).worktree.baseRef ?? '';
    expect(() => gitIn(b.wt, 'merge', '--no-edit', base)).toThrow();
    commitFile(b.wt, 'hello.txt', 'from A and main\n', 'merge main into the re-land');
    expect(ancestor(b.wt, aHead, head(b.wt))).toBe(true);
    expect(showWorktree(store, b.id).worktree.behind).toBe(0);
    const after = planJob(store, b.id);
    expect(notice(after)).toBeUndefined();
    expect(after.reason).not.toContain('Re-land of');
  });

  it('the note is absent in review', () => {
    const { b } = reland();
    toReview(store, b);
    conflictOnMain();
    const plan = planJob(store, b.id);
    expect(plan.stage).toBe('review');
    expect(plan.reason).not.toContain('Re-land of');
    expect(notice(plan)?.text).toContain('after this round');
  });

  it('falls back to the base, and says so, when A branch is missing', () => {
    const a = start(store, clone);
    const created = relandJob(store, getJob(store.db, a.id), a.token, SESSION);
    // A's branch is gone locally and was never pushed.
    const aJob = getJob(store.db, a.id);
    gitIn(clone, 'worktree', 'remove', '--force', aJob.worktreePath ?? '');
    gitIn(clone, 'branch', '-D', aJob.branch ?? '');
    const { token } = claimJob(store, created.id, { session: SESSION });
    const r = createWorktree(store, created.id, { token });
    const main = gitIn(clone, 'rev-parse', 'origin/main');
    expect(r.from).toEqual({ ref: 'origin/main', sha: main });
    expect(head(r.job.worktreePath ?? '')).toBe(main);
    const plan = planJob(store, created.id);
    expect(plan.stage).toBe('spec');
    expect(plan.reason).toContain(`its branch ${String(aJob.branch)} was not found`);
    expect(plan.reason).toContain('re-implemented from the request');
  });

  it('a job with no predecessor starts from the base, with the unchanged notice', () => {
    const c = start(store, clone);
    const created = listEvents(store.db, c.id, 100).find((e) => e.type === 'worktree.created');
    expect(created?.payload['from']).toEqual({
      ref: 'origin/main',
      sha: gitIn(clone, 'rev-parse', 'origin/main'),
    });
    const sha = commitFile(clone, 'base.txt', 'b\n');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    go(store, c, 'start');
    const plan = planJob(store, c.id);
    expect(notice(plan)?.text).toBe(
      `Base main moved: 1 commit(s) ahead of this branch at ${sha.slice(0, 7)}; ` +
        `run \`orch worktree integrate ${c.id} --token <token>\` before the next \`orch verify\`.`,
    );
    expect(plan.reason).not.toContain('Re-land of');
  });
});
