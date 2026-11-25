/**
 * The queue ends only on an outcome that would hit every ticket (`RUN_ENDING_CODES`, decision
 * 2026-11-23-queue-ends-only-on-run-wide-outcomes); any other ticket that cannot be finished is
 * reported, passed over for the session, and the next ready ticket runs. Uses tests/run-fixture.ts.
 */
import { describe, expect, it } from 'vitest';

import { ticketKey } from '../src/core/tickets.ts';
import { resumeSession } from '../src/ops/run.ts';
import { type RunnerSession, writeSession } from '../src/ops/runner-state.ts';
import {
  DEAD_PID,
  done,
  eventsOf,
  idle,
  jobsOf,
  launcher,
  queue,
  quick,
  status,
  store,
  ticket,
} from './run-fixture.ts';

describe('the queue passes over a ticket-specific outcome', () => {
  it('a merge that leaves the ticket open is reported with a true next step, and the queue goes on', async () => {
    const first = ticket('Box left', {
      priority: 'P1',
      body: '- [ ] run the benchmark after merge\n',
    });
    const second = ticket('Plain', { priority: 'P2' });

    const s = await queue(launcher(done));

    const [open, merged] = s.tickets;
    expect(open).toMatchObject({ ticketId: first, outcome: 'blocked', code: 'ticket-open' });
    expect(open?.next).toBe(
      `tick the remaining boxes (orch ticket edit ${ticketKey(first)} --body-file -) or move them to a follow-up ticket, then orch ticket done ${ticketKey(first)}`,
    );
    expect(open?.next).not.toContain('tries again');
    expect(merged).toMatchObject({ ticketId: second, outcome: 'done' });
    expect(s).toMatchObject({ completed: 1, blocked: 1 });
    expect(s.reason).toBe('no ready ticket is left that can be started (1 passed over)');
    expect(status(first)).toBe('in-progress');
    expect(eventsOf(open?.jobId ?? '', 'runner.stopped').at(-1)?.payload).toMatchObject({
      code: 'ticket-open',
      next: open?.next,
    });
  });

  it('a code no list ever named (no-progress) is passed over too', async () => {
    const first = ticket('Stuck', { priority: 'P1' });
    const second = ticket('Plain', { priority: 'P2' });
    const l = launcher(idle, idle, done);

    const s = await queue(l);

    expect(s.tickets.map((t) => [t.ticketId, t.outcome, t.code])).toEqual([
      [first, 'blocked', 'no-progress'],
      [second, 'done', 'done'],
    ]);
    expect(l.calls).toHaveLength(3);
    expect(s.reason).toBe('no ready ticket is left that can be started (1 passed over)');
  });

  it('a run-ending code (claude-failed) ends the run before the next ticket', async () => {
    const first = ticket('No claude', { priority: 'P1' });
    const second = ticket('Never started', { priority: 'P2' });
    const launch = () => ({
      pid: 0,
      startedAt: new Date().toISOString(),
      done: Promise.resolve({ code: null, signal: null, error: 'spawn claude ENOENT' }),
      kill: () => undefined,
    });

    const s = await queue({ launch, calls: [] });

    expect(s.tickets).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({
      ticketId: first,
      outcome: 'blocked',
      code: 'claude-failed',
    });
    expect(s.reason).toBe(`ticket ${ticketKey(first)} is blocked: claude: spawn claude ENOENT`);
    expect(jobsOf(second)).toHaveLength(0);
  });

  it('orch resume does not try a passed-over ticket again, even from a record without a code', async () => {
    const first = ticket('Blocked earlier', { priority: 'P1' });
    const second = ticket('Next', { priority: 'P2' });
    const ts = new Date().toISOString();
    // Written before results carried a code.
    const session: RunnerSession = {
      pid: DEAD_PID,
      startedAt: ts,
      beatAt: ts,
      mode: 'queue',
      repo: null,
      ticket: null,
      ticketId: null,
      jobId: null,
      child: null,
      results: [
        {
          ticketId: first,
          title: 'Blocked earlier',
          repo: 'x',
          jobId: null,
          outcome: 'blocked',
          reason: 'earlier',
          relands: 0,
          next: null,
        },
      ],
      skipped: [],
      finished: null,
    };
    writeSession(store.paths, session);
    const l = launcher(done);

    const r = await resumeSession(store, {}, { launch: l.launch, ...quick });

    expect(jobsOf(first)).toHaveLength(0);
    expect(r.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'blocked'],
      [second, 'done'],
    ]);
    expect(r.reason).toBe('no ready ticket is left that can be started (1 passed over)');
  });
});
