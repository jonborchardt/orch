/**
 * A Claude child that ends on a usage or rate limit ends the run at once and leaves the session
 * for `orch resume` (decision 2026-11-24-usage-limit-ends-run-resumably). The limit child is a
 * real process through ORCH_CLAUDE_SHIM. Uses tests/run-fixture.ts.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { summaryExitCode } from '../src/cli/run.ts';
import { CLAUDE_SHIM_ENV } from '../src/integrations/claude-session.ts';
import { resumeSession, startSession } from '../src/ops/run.ts';
import { readSession } from '../src/ops/runner-state.ts';
import { done, eventsOf, jobsOf, launcher, quick, status, store, ticket } from './run-fixture.ts';
import { tempDir } from './helpers.ts';

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

describe('a usage limit ends the run resumably', () => {
  it('stops after one launch, keeps the ticket in flight, and orch resume continues it', async () => {
    const first = ticket('Hits the limit', { priority: 'P1' });
    const second = ticket('Waits', { priority: 'P2' });

    // The real launcher: the shim prints the limit and exits non-zero. A real timer, so the
    // child's exit event can arrive between polls.
    const s = await startSession(
      store,
      { mode: 'queue' },
      { sleep: (ms) => delay(ms), pollMs: 20 },
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
    expect(summaryExitCode(s)).toBe(1);
    const jobId = r?.jobId ?? '';
    // One launch, not MAX_IDLE_LAUNCHES.
    expect(eventsOf(jobId, 'runner.session')).toHaveLength(1);
    expect(eventsOf(jobId, 'runner.stopped').at(-1)?.payload).toMatchObject({
      code: 'usage-limit',
      next: 'orch resume',
    });
    expect(jobsOf(second)).toHaveLength(0);
    expect(readSession(store.paths)).toMatchObject({ finished: null, ticketId: first, jobId });
    expect(status(first)).toBe('in-progress');

    const l = launcher(done);
    const resumed = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(l.calls.map((c) => c.jobId)[0]).toBe(jobId);
    expect(jobsOf(first).map((j) => j.id)).toEqual([jobId]);
    expect(resumed.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
    expect(readSession(store.paths)?.finished).not.toBeNull();
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
