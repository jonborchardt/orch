/** The ticket readiness repository check: per-call budget and the timeout memo (ticket 0101). */
import { afterEach, describe, expect, it } from 'vitest';

import { blockReasons } from '../src/core/tickets.ts';
import { commonGitDir, commonGitDirWithin } from '../src/git/repo.ts';
import {
  addTicket,
  listTickets,
  REPO_CHECK_BUDGET_MS,
  REPO_TIMEOUT_TTL_MS,
  repoProblemOf,
  ticketJobRequest,
} from '../src/ops/tickets.ts';
import { makeRepo, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore | undefined;
afterEach(() => {
  store?.cleanup();
  store = undefined;
});

/** A fake Git lookup on a fake clock: `hang` paths use up their whole timeout and time out. */
function fakeGit(hang: readonly string[]) {
  const clock = { t: 0 };
  const calls: { path: string; timeoutMs: number }[] = [];
  const lookup = (path: string, timeoutMs: number) => {
    calls.push({ path, timeoutMs });
    if (hang.includes(path)) {
      clock.t += timeoutMs;
      return { timedOut: true as const };
    }
    return `${path}/.git`;
  };
  return { clock, calls, lookup, now: () => clock.t };
}

const ready = (repoProblem: string | null) =>
  blockReasons({ type: 'bug' }, { dependencies: [], activeJob: null, repoProblem }).length === 0;

describe('repository check budget', () => {
  it('a hung checkout spends the budget; the rest are not checked and nothing is ready', () => {
    const [slow, b, c] = [tempDir(), tempDir(), tempDir()];
    const git = fakeGit([slow]);
    const problem = repoProblemOf(git.lookup, git.now);
    const tickets = [slow, slow, b, b, c].map((repoPath) => ({ repoPath }));
    const out = tickets.map((t) => problem(t));

    // One lookup for the hung checkout (two tickets share it), with the whole budget; none for b, c.
    expect(git.calls).toEqual([{ path: slow, timeoutMs: REPO_CHECK_BUDGET_MS }]);
    expect(out[0]).toMatch(/did not answer Git in time/);
    expect(out[1]).toBe(out[0]);
    for (const p of out.slice(2)) expect(p).toMatch(/was not checked/);
    const blockers = out.map((p) =>
      blockReasons({ type: 'bug' }, { dependencies: [], activeJob: null, repoProblem: p }),
    );
    for (const b of blockers) expect(b).toMatchObject([{ kind: 'repository' }]);
    expect(out.map(ready)).toEqual([false, false, false, false, false]);
  });

  it('a slow but healthy lookup leaves only the remaining budget to the next one', () => {
    const [a, b] = [tempDir(), tempDir()];
    const git = fakeGit([]);
    const problem = repoProblemOf((p, ms) => {
      git.clock.t += 500;
      return git.lookup(p, ms);
    }, git.now);
    expect([problem({ repoPath: a }), problem({ repoPath: b })]).toEqual([null, null]);
    expect(git.calls.map((c) => c.timeoutMs)).toEqual([
      REPO_CHECK_BUDGET_MS,
      REPO_CHECK_BUDGET_MS - 500,
    ]);
  });
});

describe('timeout memo', () => {
  it('remembers only timeouts, for REPO_TIMEOUT_TTL_MS', () => {
    const [slow, b] = [tempDir(), tempDir()];
    const git = fakeGit([slow]);
    repoProblemOf(git.lookup, git.now)({ repoPath: slow });
    const timedOutAt = git.clock.t;
    expect(git.calls).toHaveLength(1);

    // Within the window: no lookup for the hung checkout, still timed out; others checked.
    git.calls.length = 0;
    git.clock.t = timedOutAt + REPO_TIMEOUT_TTL_MS - 1;
    const second = repoProblemOf(git.lookup, git.now);
    expect(second({ repoPath: slow })).toMatch(/did not answer Git in time/);
    expect(second({ repoPath: b })).toBeNull();
    expect(git.calls.map((c) => c.path)).toEqual([b]);

    // A success is not remembered: the next call asks again.
    git.calls.length = 0;
    expect(repoProblemOf(git.lookup, git.now)({ repoPath: b })).toBeNull();
    expect(git.calls.map((c) => c.path)).toEqual([b]);

    // After the window the hung checkout is looked up again.
    git.calls.length = 0;
    git.clock.t = timedOutAt + REPO_TIMEOUT_TTL_MS;
    repoProblemOf(git.lookup, git.now)({ repoPath: slow });
    expect(git.calls.map((c) => c.path)).toEqual([slow]);
  });

  it('a remembered timeout blocks the ticket in listTickets and ticketJobRequest', () => {
    const s = tempStore();
    store = s;
    const repo = makeRepo('git@github.com:acme/slow.git');
    const t = addTicket(s, { title: 'Behind a hung checkout', repo });
    expect(listTickets(s, { view: 'ready' }).tickets.map((x) => x.id)).toEqual([t.id]);

    repoProblemOf(() => ({ timedOut: true }), Date.now)(t);
    const row = listTickets(s, { view: 'blocked' }).tickets[0];
    expect(row).toMatchObject({ id: t.id, ready: false });
    expect(row?.blockedBy[0]?.kind).toBe('repository');
    expect(row?.blockedBy[0]?.detail).toMatch(/did not answer Git in time/);
    expect(() => ticketJobRequest(s, t.id, undefined)).toThrow(/cannot be started/);
  });
});

describe('commonGitDirWithin', () => {
  it('matches commonGitDir in a repository and is undefined outside one', () => {
    const repo = makeRepo();
    expect(commonGitDirWithin(repo, REPO_CHECK_BUDGET_MS)).toBe(commonGitDir(repo));
    expect(commonGitDirWithin(tempDir(), REPO_CHECK_BUDGET_MS)).toBeUndefined();
  });
});
