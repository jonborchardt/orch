/**
 * The controller waits out an account usage limit, a rate limit, or an unreachable API inside its
 * own command, then relaunches the same job; past the bound it stops resumably (ticket 0180,
 * decision 2026-11-26-controller-waits-for-limits). A fake sleep with a long poll keeps the waits
 * instant. Uses tests/run-fixture.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { summaryExitCode } from '../src/cli/run.ts';
import type { ChildExit } from '../src/integrations/claude-session.ts';
import { configPath } from '../src/ops/factory.ts';
import {
  LIMIT_WAITS,
  MAX_IDLE_LAUNCHES,
  type RunOptions,
  resumeSession,
  startSession,
} from '../src/ops/run.ts';
import { requestStop, runnerSlots, stopRequests } from '../src/ops/runner-state.ts';
import {
  type Act,
  done,
  eventsOf,
  exiting,
  idle,
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

const failing = (text: string): ChildExit => ({
  code: 1,
  signal: null,
  error: null,
  stderrTail: `starting\n${text}\n`,
});

/** The first `n` launches exit with `exit` (without moving the job); later ones finish it. */
const failsThenDone = (n: number, exit: ChildExit): Launcher =>
  exiting(launcher(...Array<Act>(n).fill(idle), done), ...Array<ChildExit>(n).fill(exit));

const epoch = (ms: number) => Math.floor((Date.now() + ms) / 1000);

const opts = (l: Launcher, o: RunOptions = {}): RunOptions => ({
  launch: l.launch,
  ...quick,
  pollMs: MIN,
  ...o,
});

describe('a usage limit waits, then continues the same job', () => {
  it('with a parsed reset: waits until it plus the margin and relaunches (AC1)', async () => {
    const id = ticket('Reset known');
    const reset = epoch(3_000);
    const l = failsThenDone(1, failing(`Claude AI usage limit reached|${String(reset)}`));
    const { seen, sleep } = sleeper();

    const s = await startSession(
      store,
      { mode: 'ticket', ticket: id },
      opts(l, { sleep, pollMs: 500 }),
    );

    const until = new Date((reset + LIMIT_WAITS.marginSeconds) * 1000).toISOString();
    expect(seen.waits).toEqual([{ reason: 'the usage limit to reset', until }]);
    expect(seen.status?.wait).toEqual({ reason: 'the usage limit to reset', until });
    expect(seen.status?.next).toContain('Waiting for the usage limit to reset at');
    expect(seen.status?.next).toContain(
      `then continue ticket ${seen.status?.current?.ticket ?? '?'}`,
    );
    const [job] = jobsOf(id);
    expect(l.calls.map((c) => c.jobId)).toEqual([job?.id, job?.id]);
    expect(jobsOf(id)).toHaveLength(1);
    expect(s.tickets.map((t) => t.outcome)).toEqual(['done']);
    expect(status(id)).toBe('done');
    expect(lastSession()?.wait).toBeNull();
  });

  it('without one: probes, then stops resumably past the bound; resume continues (AC2, AC8)', async () => {
    const first = ticket('No reset', { priority: 'P1' });
    const second = ticket('Not taken', { priority: 'P2' });
    const l = failsThenDone(99, failing('5-hour limit reached ∙ resets 3pm'));
    const { seen, sleep } = sleeper();

    const s = await startSession(
      store,
      { mode: 'queue' },
      opts(l, { sleep, limitWaits: { probeSeconds: 60, boundSeconds: 180 } }),
    );

    // Three probes of a minute fit the bound; the fourth would not.
    expect(l.calls).toHaveLength(4);
    expect(seen.waitMs).toBe(3 * MIN);
    expect(seen.waits.every((w) => w.reason === 'the next usage limit probe')).toBe(true);
    expect(s.tickets).toMatchObject([
      { ticketId: first, outcome: 'blocked', code: 'usage-limit', next: 'orch resume' },
    ]);
    expect(s.reason).toBe(
      'Claude usage limit reached (resets 3pm); orch resume continues the session',
    );
    expect(summaryExitCode(s)).toBe(1);
    const jobId = jobsOf(first)[0]?.id ?? '';
    expect(lastSession()).toMatchObject({ finished: null, ticketId: first, jobId, wait: null });
    expect(eventsOf(jobId, 'runner.stopped').at(-1)?.payload['code']).toBe('usage-limit');
    expect(jobsOf(second)).toHaveLength(0);

    const r = launcher(done);
    const resumed = await resumeSession(store, {}, opts(r));
    expect(r.calls[0]?.jobId).toBe(jobId);
    expect(jobsOf(first).map((j) => j.id)).toEqual([jobId]);
    expect(resumed.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
  });

  it('a reset more than 12 hours ahead stops at once and names it (AC3)', async () => {
    const id = ticket('Weekly');
    const reset = epoch(13 * 3600_000);
    const l = failsThenDone(1, failing(`Claude AI usage limit reached|${String(reset)}`));

    const s = await startSession(store, { mode: 'ticket', ticket: id }, opts(l));

    expect(l.calls).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({ outcome: 'blocked', code: 'usage-limit' });
    expect(s.reason).toContain(new Date(reset * 1000).toISOString());
    expect(lastSession()).toMatchObject({ finished: null, ticketId: id });

    await resumeSession(store, {}, opts(launcher(done)));
    expect(status(id)).toBe('done');
  });
});

describe('a rate limit backs off (AC5)', () => {
  it('relaunches the same job on 1, 2 minutes, then stops resumably with usage-limit', async () => {
    const id = ticket('429');
    const l = failsThenDone(
      99,
      failing('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'),
    );
    const { seen, sleep } = sleeper();

    const s = await startSession(
      store,
      { mode: 'ticket', ticket: id },
      opts(l, { sleep, limitWaits: { boundSeconds: 200 } }),
    );

    // 60 + 120 fit 200 seconds; 240 more would not.
    expect(seen.waitMs).toBe(3 * MIN);
    expect(seen.waits.every((w) => w.reason === 'the next try after a rate limit')).toBe(true);
    expect(new Set(l.calls.map((c) => c.jobId)).size).toBe(1);
    expect(l.calls).toHaveLength(3);
    expect(s.tickets[0]).toMatchObject({
      outcome: 'blocked',
      code: 'usage-limit',
      next: 'orch resume',
    });

    await resumeSession(store, {}, opts(launcher(done)));
    expect(status(id)).toBe('done');
  });
});

describe('an unreachable API waits instead of passing tickets over (AC7)', () => {
  const OUTAGE = failing("API Error: Can't reach the API server at api.anthropic.com (ENOTFOUND)");

  it('never ends no-progress, keeps its ticket, backs off 1, 2, 4, 8, 15, 15 minutes', async () => {
    const first = ticket('Offline', { priority: 'P1' });
    const second = ticket('After', { priority: 'P2' });
    const fails = 6;
    expect(fails).toBeGreaterThan(MAX_IDLE_LAUNCHES);
    const l = failsThenDone(fails, OUTAGE);
    const { seen, sleep } = sleeper();

    const s = await startSession(store, { mode: 'queue' }, opts(l, { sleep }));

    expect(seen.waitMs).toBe((1 + 2 + 4 + 8 + 15 + 15) * MIN);
    expect(seen.waits).toHaveLength(fails);
    expect(seen.waits.every((w) => w.reason === 'the next try at reaching the Claude API')).toBe(
      true,
    );
    const a = jobsOf(first)[0]?.id;
    const b = jobsOf(second)[0]?.id;
    expect(l.calls.map((c) => c.jobId)).toEqual([
      ...Array<string | undefined>(fails + 1).fill(a),
      b,
    ]);
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
  });

  it('past the bound stops resumably with api-unreachable; orch resume takes it first (AC7, AC8)', async () => {
    const first = ticket('Still offline', { priority: 'P1' });
    const second = ticket('Waits its turn', { priority: 'P2' });
    const l = failsThenDone(99, OUTAGE);
    const { sleep } = sleeper();

    const s = await startSession(
      store,
      { mode: 'queue' },
      opts(l, { sleep, limitWaits: { boundSeconds: 180 } }),
    );

    expect(l.calls).toHaveLength(3);
    expect(s.tickets).toMatchObject([
      { ticketId: first, outcome: 'blocked', code: 'api-unreachable', next: 'orch resume' },
    ]);
    expect(s.reason).toContain("Can't reach the API server");
    expect(summaryExitCode(s)).toBe(1);
    const jobId = jobsOf(first)[0]?.id ?? '';
    expect(lastSession()).toMatchObject({ finished: null, ticketId: first, jobId, wait: null });
    expect(jobsOf(second)).toHaveLength(0);

    const r = launcher(done);
    const resumed = await resumeSession(store, {}, opts(r));
    expect(r.calls[0]?.jobId).toBe(jobId);
    expect(resumed.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
  });
});

describe('a wait ends on a stop or a changed environment', () => {
  const LIMIT = failing('5-hour limit reached ∙ resets 3pm');
  const live = () => runnerSlots(store.paths).filter((x) => x.pid !== null);

  it.each(['now', 'next', 'signal'] as const)(
    'orch stop %s ends it within one poll; the job stays in flight (AC9)',
    async (how) => {
      const id = ticket(`Stopped by ${how}`);
      const l = failsThenDone(99, LIMIT);
      const abort = new AbortController();
      let after = -1;
      const { sleep } = sleeper(() => {
        after += 1;
        if (after > 0) return;
        if (how === 'signal') abort.abort();
        else for (const x of live()) requestStop(store.paths, how, x.key);
      });

      const s = await startSession(
        store,
        { mode: 'ticket', ticket: id },
        opts(l, { sleep, signal: abort.signal }),
      );

      expect(after).toBe(0); // no further poll once the stop was there
      expect(l.calls).toHaveLength(1);
      expect(s.tickets[0]).toMatchObject({ ticketId: id, outcome: 'stopped' });
      const jobId = jobsOf(id)[0]?.id ?? '';
      expect(lastSession()).toMatchObject({ finished: null, ticketId: id, jobId, wait: null });
      const slot = runnerSlots(store.paths).find((x) => x.session?.ticket === id);
      expect(stopRequests(store.paths, slot?.key).next).toBe(how === 'next');

      await resumeSession(store, {}, opts(launcher(done)));
      expect(status(id)).toBe('done');
    },
  );

  it('a rebuild during the wait halts with orch-rebuilt, never relaunching (AC10)', async () => {
    const id = ticket('Rebuilt meanwhile');
    let version = 'v1';
    const l = failsThenDone(99, LIMIT);
    const { sleep } = sleeper(() => (version = 'v2'));

    const s = await startSession(
      store,
      { mode: 'ticket', ticket: id },
      opts(l, { sleep, build: () => version }),
    );

    expect(l.calls).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({ outcome: 'blocked', code: 'orch-rebuilt' });
    expect(s.handoff).toBeDefined();

    await resumeSession(store, {}, opts(launcher(done), { build: () => version }));
    expect(status(id)).toBe('done');
  });

  it('a factory.json gone bad during the wait halts with bad-config (AC10)', async () => {
    const id = ticket('Config broke meanwhile');
    const file = configPath(store);
    const good = readFileSync(file, 'utf8');
    const l = failsThenDone(99, LIMIT);
    const { sleep } = sleeper(() => {
      const raw = JSON.parse(good) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify({ ...raw, models: { 'spec-writer': 'gpt-9' } }));
    });

    try {
      const s = await startSession(store, { mode: 'ticket', ticket: id }, opts(l, { sleep }));
      expect(l.calls).toHaveLength(1);
      expect(s.tickets[0]).toMatchObject({ outcome: 'blocked', code: 'bad-config' });
    } finally {
      writeFileSync(file, good);
    }

    await resumeSession(store, {}, opts(launcher(done)));
    expect(status(id)).toBe('done');
  });
});
