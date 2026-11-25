/**
 * `orch usage backfill` (ticket 0144): transcripts under a temp CLAUDE_CONFIG_DIR are matched to
 * jobs only by their `cwd` being the job's worktree path; the CLI runs outside the repository with
 * a temp ORCH_HOME.
 */
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BackfillReport } from '../src/ops/token-usage.ts';
import { tokenUsage } from '../src/server/api.ts';
import { createJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { recordedRefs } from '../src/storage/usage.ts';
import { orch, tempDir, type TempStore, tempStore } from './helpers.ts';
import { at, U, usage, user, writeSession } from './transcript-fixture.ts';

const U2 = '22222222-3333-4444-8555-666666666666';
const U3 = '33333333-4444-4555-8666-777777777777';
const U4 = '44444444-5555-4666-8777-888888888888';
const NOW = Date.parse(at(3 * 3600 + 1800));

let store: TempStore;
let claude: string;
let outside: string;
beforeEach(() => {
  store = tempStore();
  claude = tempDir('claude-');
  outside = tempDir('cwd-');
});
afterEach(() => {
  store.cleanup();
});

const wt = (id: string) => join(store.home, 'worktrees', 'github.com-acme-alpha', id);
function mkJob(title: string, done: boolean): { id: string; path: string } {
  const j = createJob(store, {
    title,
    description: title,
    repo: 'github.com/acme/alpha',
    repoPath: outside,
    baseBranch: 'main',
  });
  // The worktree directory itself does not exist: the stored path still matches.
  const path = wt(j.id);
  const end = at(3 * 3600);
  store.db
    .update(jobs)
    .set({
      worktreePath: path,
      ...(done
        ? { stage: 'completed', status: 'completed', updatedAt: end, completedAt: end }
        : {}),
    })
    .where(eq(jobs.id, j.id))
    .run();
  return { id: j.id, path };
}
const complete = (id: string) =>
  store.db
    .update(jobs)
    .set({ stage: 'completed', status: 'completed' })
    .where(eq(jobs.id, id))
    .run();
const transcript = (cwd: string, ref: string, i: number) =>
  writeSession(claude, 'p', [user(0, 'go', { cwd }), usage(1, `m-${ref}`, { i })].join('\n'), ref);
const backfill = (json: boolean) => {
  const r = orch(store.home, outside, ['usage', 'backfill', ...(json ? ['--json'] : [])], {
    CLAUDE_CONFIG_DIR: claude,
  });
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return r.out;
};

describe('orch usage backfill', () => {
  it('records matching finished jobs only, lists the rest, and records nothing twice (AC7, AC12)', () => {
    const a = mkJob('Never attached', true);
    const b = mkJob('No transcript', true);
    const c = mkJob('Still running', false);
    transcript(process.platform === 'win32' ? a.path.toUpperCase() : a.path, U, 5);
    transcript(c.path, U2, 9);
    const orphan = wt('job-deadbeef');
    transcript(orphan, U3, 100);
    // A primary-checkout session: neither matched nor reported.
    transcript(outside, U4, 1000);

    const first = JSON.parse(backfill(true)) as BackfillReport;
    expect(first.recorded).toEqual([{ jobId: a.id, refs: [U] }]);
    expect(first.unmatchedJobs).toEqual([{ jobId: b.id, worktreePath: b.path }]);
    expect(first.unfinished).toEqual([{ jobId: c.id, ref: U2, status: 'pending' }]);
    expect(first.orphans).toEqual([{ ref: U3, cwd: orphan }]);
    expect(first.skipped).toEqual([]);
    expect(recordedRefs(store.db)).toEqual(new Set([U]));
    // The job with no session.attached now shows in the Usage view.
    expect(tokenUsage(store, '24', NOW).jobs).toMatchObject([
      { id: a.id, input: 5, missing: null },
    ]);

    const text = backfill(false);
    expect(text).toContain('Recorded 0 session(s) on 0 job(s).');
    expect(text).toContain(`${b.id}: ${b.path}`);
    expect(text).toContain(`${c.id}: ${U2} (pending)`);
    expect(text).toContain(`${U3}: ${orphan}`);
    expect(recordedRefs(store.db)).toEqual(new Set([U]));

    complete(c.id);
    const third = JSON.parse(backfill(true)) as BackfillReport;
    expect(third.recorded).toEqual([{ jobId: c.id, refs: [U2] }]);
    expect(third.unfinished).toEqual([]);
    expect(recordedRefs(store.db)).toEqual(new Set([U, U2]));
  });
});
