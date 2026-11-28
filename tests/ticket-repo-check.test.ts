/** The ticket readiness repository check: per-call budget and the timeout memo (ticket 0101). */
import { afterEach, describe, expect, it } from 'vitest';

import { CheckoutTimeoutError, ToolError, ValidationError } from '../src/core/errors.ts';
import { blockReasons } from '../src/core/tickets.ts';
import { commonGitDir, commonGitDirWithin } from '../src/git/repo.ts';
import {
  addTicket,
  DISPATCH_REPO_CHECK_BUDGET_MS,
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

  it('a remembered timeout blocks the ticket in listTickets; ticketJobRequest asks Git itself', () => {
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
    // The dispatch path ignores the memo: its own lookup, with its own budget, answers.
    expect(ticketJobRequest(s, t.id, undefined).path).toBe(t.repoPath);
    const git = fakeGit([]);
    ticketJobRequest(s, t.id, undefined, git.lookup);
    expect(git.calls).toEqual([{ path: t.repoPath, timeoutMs: DISPATCH_REPO_CHECK_BUDGET_MS }]);
    expect(DISPATCH_REPO_CHECK_BUDGET_MS).toBe(30_000);
    // And it leaves the memo alone: the list is still blocked.
    expect(listTickets(s, { view: 'ready' }).tickets).toEqual([]);
  });
});

describe('ticketJobRequest', () => {
  it('a timeout is a CheckoutTimeoutError that is not memoized; missing and wrong target stay ValidationErrors', () => {
    const s = tempStore();
    store = s;
    const repo = makeRepo('git@github.com:acme/dispatch.git');
    const t = addTicket(s, { title: 'Dispatched', repo });
    const thrown = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (e) {
        return e;
      }
      return undefined;
    };

    const slow = thrown(() => ticketJobRequest(s, t.id, undefined, () => ({ timedOut: true })));
    expect(slow).toBeInstanceOf(CheckoutTimeoutError);
    expect(slow).not.toBeInstanceOf(ValidationError);
    expect((slow as Error).message).toMatch(/did not answer Git within 30 s\. Nothing was created/);
    // Not written to the list's memo: the ticket is still ready there.
    expect(listTickets(s, { view: 'ready' }).tickets.map((x) => x.id)).toEqual([t.id]);

    const missing = thrown(() => ticketJobRequest(s, t.id, undefined, () => undefined));
    expect(missing).toBeInstanceOf(ValidationError);
    expect((missing as Error).message).toMatch(/is not available here.*Nothing was created/);

    const elsewhere = thrown(() => ticketJobRequest(s, t.id, makeRepo()));
    expect(elsewhere).toBeInstanceOf(ValidationError);
    expect((elsewhere as Error).message).toMatch(/another repository.*Nothing was created/);
  });
});

describe('commonGitDirWithin', () => {
  it('matches commonGitDir in a repository and is undefined outside one', () => {
    const repo = makeRepo();
    expect(commonGitDirWithin(repo, REPO_CHECK_BUDGET_MS)).toBe(commonGitDir(repo));
    expect(commonGitDirWithin(tempDir(), REPO_CHECK_BUDGET_MS)).toBeUndefined();
  });

  it('commonGitDir throws a ToolError carrying the Git error text outside a repository', () => {
    let thrown: unknown;
    try {
      commonGitDir(tempDir());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).message).toMatch(/^git rev-parse failed in /);
    expect((thrown as ToolError).message).toMatch(/not a git repository/i);
  });
});
