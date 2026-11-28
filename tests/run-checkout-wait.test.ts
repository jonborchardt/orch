/**
 * A ticket whose checkout does not answer Git at dispatch is kept: the controller waits 15, 30,
 * 60, then every 120 s and dispatches it again; past 30 minutes it stops resumably (ticket 0214,
 * decision 2026-11-27-controller-waits-for-slow-git). The Git lookup is replaced for the dispatch
 * budget only, so the polled list keeps its real 2 s check. Uses tests/run-fixture.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { summaryExitCode } from '../src/cli/run.ts';
import { endsRun } from '../src/core/workflow.ts';
import { configPath } from '../src/ops/factory.ts';
import { CHECKOUT_WAITS, type RunOptions, resumeSession, startSession } from '../src/ops/run.ts';
import { requestStop, runnerSlots, stopRequests } from '../src/ops/runner-state.ts';
import { DISPATCH_REPO_CHECK_BUDGET_MS } from '../src/ops/tickets.ts';
import {
  done,
  jobsOf,
  type Launcher,
  launcher,
  lastSession,
  MIN,
  quick,
  sleeper,
  status,
  store,
  ticket,
} from './run-fixture.ts';

/** What the dispatch lookup answers: `timeouts` times a timeout, then Git's real answer. */
const git = vi.hoisted(() => ({ timeouts: 0, missing: false, dispatchLookups: 0 }));
vi.mock('../src/git/repo.ts', async (original) => {
  const real = await original<typeof import('../src/git/repo.ts')>();
  return {
    ...real,
    commonGitDirWithin: (cwd: string, timeoutMs: number) => {
      if (timeoutMs !== 30_000) return real.commonGitDirWithin(cwd, timeoutMs);
      git.dispatchLookups += 1;
      if (git.missing) return undefined;
      if (git.timeouts <= 0) return real.commonGitDirWithin(cwd, timeoutMs);
      git.timeouts -= 1;
      return { timedOut: true as const };
    },
  };
});
beforeEach(() => {
  Object.assign(git, { timeouts: 0, missing: false, dispatchLookups: 0 });
});

const WAIT = 'the repository checkout to answer Git';

// A poll longer than any wait: one sleep per wait.
const opts = (l: Launcher, o: RunOptions = {}): RunOptions => ({
  launch: l.launch,
  ...quick,
  pollMs: 10 * MIN,
  ...o,
});

describe('a checkout that does not answer Git at dispatch', () => {
  it('the budget the mock stands in for, the run-wide code, and the waits', () => {
    expect(DISPATCH_REPO_CHECK_BUDGET_MS).toBe(30_000);
    expect(endsRun('checkout-timeout')).toBe(true);
    expect(CHECKOUT_WAITS).toEqual({ boundSeconds: 1800, backoffSeconds: [15, 30, 60, 120] });
  });

  it('waits 15, 30, 60, 120, 120 s on the same ticket, then dispatches and finishes it (AC4)', async () => {
    const first = ticket('Behind a busy disk', { priority: 'P1' });
    const second = ticket('After it', { priority: 'P2' });
    git.timeouts = 5;
    const { seen, sleep } = sleeper();
    const l = launcher(done);

    const s = await startSession(store, { mode: 'queue' }, opts(l, { sleep }));

    expect(seen.sleeps.map((ms) => ms / 1000)).toEqual([15, 30, 60, 120, 120]);
    expect(seen.waits.every((w) => w.reason === WAIT)).toBe(true);
    expect(lastSession()?.wait ?? null).toBeNull();
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
    expect(s.skipped).toEqual([]);
    expect(s.reason).toBe('no ready ticket is left');
    expect(jobsOf(first)).toHaveLength(1);
    expect(status(first)).toBe('done');
  });

  it('past 30 minutes ends the run resumably with the ticket in flight; resume takes it (AC5)', async () => {
    const first = ticket('Hung disk', { priority: 'P1' });
    const second = ticket('Not taken', { priority: 'P2' });
    git.timeouts = Infinity;
    const { seen, sleep } = sleeper();
    const l = launcher(done);

    const s = await startSession(store, { mode: 'queue' }, opts(l, { sleep }));

    // 15 + 30 + 60 + 14 x 120 = 1785 s; one more wait would pass the bound.
    expect(seen.sleeps).toHaveLength(17);
    expect(seen.waitMs).toBe(1785_000);
    expect(l.calls).toHaveLength(0);
    expect(s.tickets).toMatchObject([
      { ticketId: first, outcome: 'blocked', code: 'checkout-timeout', next: 'orch resume' },
    ]);
    expect(s.reason).toMatch(/did not answer Git within 30 s.*orch resume continues the session/);
    expect(s.reason).not.toContain('passed over');
    expect(s.skipped).toEqual([]);
    expect(summaryExitCode(s)).toBe(1);
    expect(lastSession()).toMatchObject({
      finished: null,
      ticketId: first,
      jobId: null,
      wait: null,
      skipped: [],
    });
    expect([...jobsOf(first), ...jobsOf(second)]).toHaveLength(0);
    expect(status(first)).toBe('open');

    git.timeouts = 0;
    const r = launcher(done);
    const resumed = await resumeSession(store, {}, opts(r));
    expect(r.calls[0]?.jobId).toBe(jobsOf(first)[0]?.id);
    expect(resumed.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
  });

  it.each(['now', 'next'] as const)(
    'orch stop %s ends the wait at once as stopped, the ticket kept in flight (AC6)',
    async (how) => {
      const id = ticket(`Stopped by ${how}`);
      git.timeouts = Infinity;
      const { seen, sleep } = sleeper(() => {
        for (const x of runnerSlots(store.paths)) {
          if (x.pid !== null) requestStop(store.paths, how, x.key);
        }
      });

      const s = await startSession(store, { mode: 'queue' }, opts(launcher(done), { sleep }));

      expect(seen.sleeps).toHaveLength(1);
      expect(git.dispatchLookups).toBe(1);
      expect(s.stopped).toBe(true);
      expect(s.tickets).toMatchObject([{ ticketId: id, outcome: 'stopped', next: 'orch resume' }]);
      expect(lastSession()).toMatchObject({ finished: null, ticketId: id, wait: null });
      expect(jobsOf(id)).toHaveLength(0);
      const slot = runnerSlots(store.paths).find((x) => x.session !== null);
      expect(stopRequests(store.paths, slot?.key).next).toBe(how === 'next');

      git.timeouts = 0;
      await resumeSession(store, {}, opts(launcher(done)));
      expect(status(id)).toBe('done');
    },
  );

  it('a rebuild during the wait halts with orch-rebuilt before any retry dispatch (AC7)', async () => {
    const id = ticket('Rebuilt meanwhile');
    git.timeouts = Infinity;
    let version = 'v1';
    const { sleep } = sleeper(() => (version = 'v2'));

    const s = await startSession(
      store,
      { mode: 'queue' },
      opts(launcher(done), { sleep, build: () => version }),
    );

    expect(git.dispatchLookups).toBe(1);
    expect(s.tickets[0]).toMatchObject({ ticketId: id, outcome: 'blocked', code: 'orch-rebuilt' });
    expect(s).toMatchObject({ interrupted: true });
    expect(s.handoff).toBeDefined();
    expect(lastSession()).toMatchObject({ finished: null, ticketId: id });
    expect(jobsOf(id)).toHaveLength(0);

    git.timeouts = 0;
    await resumeSession(store, {}, opts(launcher(done), { build: () => version }));
    expect(status(id)).toBe('done');
  });

  it('a factory.json gone bad during the wait halts with bad-config before any retry dispatch (AC7)', async () => {
    const id = ticket('Config broke meanwhile');
    git.timeouts = Infinity;
    const file = configPath(store);
    const good = readFileSync(file, 'utf8');
    const { sleep } = sleeper(() => {
      const raw = JSON.parse(good) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...raw, models: { 'spec-writer': 'gpt-9' } }));
    });

    try {
      const s = await startSession(store, { mode: 'queue' }, opts(launcher(done), { sleep }));
      expect(git.dispatchLookups).toBe(1);
      expect(s.tickets[0]).toMatchObject({ ticketId: id, outcome: 'blocked', code: 'bad-config' });
      expect(s).toMatchObject({ interrupted: true });
      expect(jobsOf(id)).toHaveLength(0);
    } finally {
      writeFileSync(file, good);
    }

    git.timeouts = 0;
    await resumeSession(store, {}, opts(launcher(done)));
    expect(status(id)).toBe('done');
  });

  it('a missing checkout is still refused at once and passed over, with no wait (AC8)', async () => {
    const id = ticket('Checkout gone');
    git.missing = true;
    const { seen, sleep } = sleeper();
    const l = launcher(done);

    const s = await startSession(store, { mode: 'queue' }, opts(l, { sleep }));

    expect(seen.sleeps).toEqual([]);
    expect(git.dispatchLookups).toBe(1);
    expect(s.tickets).toMatchObject([{ ticketId: id, outcome: 'refused' }]);
    expect(s.tickets[0]?.reason).toMatch(/is not available here/);
    expect(s.reason).toBe('no ready ticket is left that can be started (1 passed over)');
    expect(lastSession()).toMatchObject({ ticketId: null });
    expect(jobsOf(id)).toHaveLength(0);
  });
});
