/**
 * A Claude child that ends on a usage or rate limit is waited out and relaunched; past the bound
 * the run ends and leaves the session for `orch resume` (decisions
 * 2026-11-24-usage-limit-ends-run-resumably, 2026-11-26-controller-waits-for-limits). The limit
 * child is a real process through ORCH_CLAUDE_SHIM. Uses tests/run-fixture.ts.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { summaryExitCode } from '../src/cli/run.ts';
import { CLAUDE_SHIM_ENV } from '../src/integrations/claude-session.ts';
import { resumeSession, startSession } from '../src/ops/run.ts';
import { usageInRange } from '../src/storage/usage.ts';
import {
  type Act,
  done,
  eventsOf,
  finish,
  jobsOf,
  launcher,
  one,
  quick,
  status,
  store,
  ticket,
  lastSession,
} from './run-fixture.ts';
import { tempDir } from './helpers.ts';
import { usage, writeSession } from './transcript-fixture.ts';

let dir: string;
beforeAll(() => {
  dir = tempDir('orch-limit-shim-');
  const script = join(dir, 'claude-limit.cjs');
  writeFileSync(
    script,
    "process.stderr.write('5-hour limit reached \\u2219 resets 3pm\\n'); process.exitCode = 1;\n",
  );
  process.env[CLAUDE_SHIM_ENV] = script;
});
afterAll(() => {
  Reflect.deleteProperty(process.env, CLAUDE_SHIM_ENV);
  rmSync(dir, { recursive: true, force: true });
});

describe('a usage limit ends the run resumably past the wait', () => {
  it('probes, stops past the bound, keeps the ticket in flight, and orch resume continues it', async () => {
    const first = ticket('Hits the limit', { priority: 'P1' });
    const second = ticket('Waits', { priority: 'P2' });

    // The real launcher: the shim prints the limit and exits non-zero. A real timer, so the
    // child's exit event can arrive between polls. Two 20 ms probes fit a 50 ms bound.
    const s = await startSession(
      store,
      { mode: 'queue' },
      {
        sleep: (ms) => delay(ms),
        pollMs: 20,
        limitWaits: { probeSeconds: 0.02, boundSeconds: 0.05 },
      },
    );

    expect(s.tickets).toHaveLength(1);
    const [r] = s.tickets;
    expect(r).toMatchObject({
      ticketId: first,
      outcome: 'blocked',
      code: 'usage-limit',
      next: 'orch resume',
    });
    expect(s.reason).toBe(
      'Claude usage limit reached (resets 3pm); orch resume continues the session',
    );
    expect(s.stopped).toBe(false);
    expect(s.handoff).toBeUndefined(); // only orch-rebuilt hands off
    expect(summaryExitCode(s)).toBe(1);
    const jobId = r?.jobId ?? '';
    // The first launch and one per probe; never no-progress after MAX_IDLE_LAUNCHES.
    expect(eventsOf(jobId, 'runner.session')).toHaveLength(3);
    expect(eventsOf(jobId, 'runner.stopped').at(-1)?.payload).toMatchObject({
      code: 'usage-limit',
      next: 'orch resume',
    });
    expect(jobsOf(second)).toHaveLength(0);
    expect(lastSession()).toMatchObject({ finished: null, ticketId: first, jobId });
    expect(status(first)).toBe('in-progress');

    const l = launcher(done);
    const resumed = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(l.calls.map((c) => c.jobId)[0]).toBe(jobId);
    expect(jobsOf(first).map((j) => j.id)).toEqual([jobId]);
    expect(resumed.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
    expect(lastSession()?.finished).not.toBeNull();
  });

  it('a child that moves the job and only talks about a rate limit completes its ticket', async () => {
    const id = ticket('Talks about limits');
    const l = launcher(done);
    const base = l.launch;
    l.launch = (input) => ({
      ...base(input),
      done: Promise.resolve({
        code: 0,
        signal: null,
        error: null,
        stderrTail: '',
        result: {
          subtype: 'success',
          isError: false,
          result: 'We hit the rate limit, resets 3pm, but finished',
          numTurns: 3,
        },
      }),
    });

    const s = await startSession(
      store,
      { mode: 'ticket', ticket: id },
      { launch: l.launch, ...quick },
    );

    expect(s.tickets[0]).toMatchObject({ ticketId: id, outcome: 'done' });
    expect(status(id)).toBe('done');
  });
});

describe('token usage of a runner child (ticket 0144 AC3)', () => {
  it("records the child's session on its job once it exits; a missing transcript changes nothing", async () => {
    const saved = process.env['CLAUDE_CONFIG_DIR'];
    const claude = tempDir('claude-');
    process.env['CLAUDE_CONFIG_DIR'] = claude;
    try {
      const writes: Act = (job, input) => {
        writeSession(claude, 'p', usage(0, 'm1', { i: 7, o: 2 }), input.sessionId);
        finish(job);
      };
      const a = ticket('Leaves a transcript');
      const ra = await one(launcher(writes), a);
      const b = ticket('Leaves none');
      const rb = await one(launcher(done), b);

      const [ja] = jobsOf(a);
      const [jb] = jobsOf(b);
      const [ea] = eventsOf(ja?.id ?? '', 'runner.session');
      const [eb] = eventsOf(jb?.id ?? '', 'runner.session');
      const rows = usageInRange(store.db, 0, Number.MAX_SAFE_INTEGER);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ref: ea?.payload['sessionId'],
        jobId: ja?.id,
        source: 'runner',
      });
      expect(rows[0]?.hours).toMatchObject([{ input: 7, output: 2 }]);

      // Without a transcript nothing is stored, and the outcome and evidence are the same.
      expect(ra.tickets.map((t) => t.outcome)).toEqual(['done']);
      expect(rb.tickets.map((t) => t.outcome)).toEqual(['done']);
      const shape = (p: Record<string, unknown> | undefined) => {
        const rest = { ...p };
        for (const k of ['pid', 'seconds', 'sessionId']) Reflect.deleteProperty(rest, k);
        return rest;
      };
      expect(shape(eb?.payload)).toEqual(shape(ea?.payload));
      expect(status(b)).toBe('done');
    } finally {
      process.env['CLAUDE_CONFIG_DIR'] = saved;
    }
  });
});
