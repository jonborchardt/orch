/**
 * A limit on a model with its own allowance (fable) does not end the run while every affected
 * role has another model in its pool: the controller records `models.fallback` and relaunches
 * (ticket 0179, decision 2026-11-26-per-model-limit-falls-back). Uses tests/run-fixture.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ChildExit } from '../src/integrations/claude-session.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { planJob } from '../src/ops/factory.ts';
import { reportLimit } from '../src/ops/model-limit.ts';
import { LIMIT_WAITS, RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { jobUsage } from '../src/ops/usage.ts';
import { claimJob } from '../src/storage/jobs.ts';
import {
  type Act,
  clone,
  done,
  eventsOf,
  idle,
  type Launcher,
  launcher,
  lastSession,
  one,
  queue,
  quick,
  status,
  store,
  ticket,
} from './run-fixture.ts';

/** Set the role models, keeping the rest of the user config (the fixture's merge opt-in). */
const config = (models: Record<string, unknown>) => {
  const file = join(store.paths.config, 'factory.json');
  const rest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...rest, models }));
};
const POOLS = { 'spec-writer': ['fable', 'opus'], builder: ['fable', 'opus'] };

/** A ticket whose job drew fable for `roles`; afterwards the config holds `pools`. */
function fableJob(
  title: string,
  pools: Record<string, unknown> = POOLS,
  roles = ['spec-writer', 'builder'],
  o: Record<string, unknown> = {},
): { ticketId: number; jobId: string } {
  config(Object.fromEntries(roles.map((r) => [r, 'fable'])));
  const ticketId = ticket(title, o);
  const { job } = dispatchJob(store, { ticket: ticketId, session: RUNNER_SESSION, cwd: clone });
  config(pools);
  return { ticketId, jobId: job.id };
}

const limited = (text: string): ChildExit => ({
  code: 1,
  signal: null,
  error: null,
  stderrTail: `starting\n${text}\n`,
});

/** The n-th launch exits with `exits[n]` when it is set, else the fixture's ordinary exit. */
function exiting(l: Launcher, ...exits: (ChildExit | null)[]): Launcher {
  const base = l.launch;
  l.launch = (input) => {
    const child = base(input);
    const exit = exits[l.calls.length - 1];
    return exit ? { ...child, done: Promise.resolve(exit) } : child;
  };
  return l;
}

const fallbacks = (jobId: string) => eventsOf(jobId, 'models.fallback').map((e) => e.payload);
const agentsOf = (jobId: string) =>
  Object.fromEntries(planJob(store, jobId).agents.map((a) => [a.role, a.model]));
const fell = (text: string, until: string | null = null) =>
  ['spec-writer', 'builder'].map((role) => ({ role, from: 'fable', to: 'opus', text, until }));

describe('a fable limit falls back to the next pool model', () => {
  it('in stderr: records models.fallback, relaunches, and the plan runs opus (AC5)', async () => {
    const { ticketId, jobId } = fableJob('Hits the fable limit');
    const seen: Record<string, string>[] = [];
    const l = exiting(
      launcher(
        (job) => {
          seen.push(agentsOf(job.id));
        },
        (job, input) => {
          seen.push(agentsOf(job.id));
          done(job, input);
        },
      ),
      limited('Fable limit reached'),
    );

    const s = await one(l, ticketId);

    expect(s.tickets.map((t) => [t.jobId, t.outcome])).toEqual([[jobId, 'done']]);
    expect(l.calls).toHaveLength(2);
    expect(seen).toEqual([{ 'spec-writer': 'fable' }, { 'spec-writer': 'opus' }]);
    expect(eventsOf(jobId, 'models.limit').map((e) => e.payload)).toEqual([
      { model: 'fable', text: 'Fable limit reached', until: null },
    ]);
    expect(fallbacks(jobId)).toEqual(fell('Fable limit reached'));
    expect(jobUsage(store, jobId).models).toMatchObject({ builder: 'opus', approver: 'opus' });
    expect(eventsOf(jobId, 'runner.stopped')).toHaveLength(0);
    expect(status(ticketId)).toBe('done');
  });

  it('reported by the session with orch job limit: the same (AC5)', async () => {
    const { ticketId, jobId } = fableJob('A subagent hits the fable limit');
    const report: Act = (job) => {
      reportLimit(
        store,
        job.id,
        { token: job.ownerToken ?? '' },
        { model: 'fable', text: 'builder: Fable limit reached' },
      );
    };
    const l = launcher(report, done);

    const s = await one(l, ticketId);

    expect(s.tickets.map((t) => t.outcome)).toEqual(['done']);
    expect(l.calls).toHaveLength(2);
    expect(eventsOf(jobId, 'models.limit')).toHaveLength(1);
    expect(fallbacks(jobId)).toEqual(fell('builder: Fable limit reached'));
  });

  it('a later job drawn fable falls back before its first launch, same controller (AC6)', async () => {
    const a = fableJob('First', POOLS, undefined, { priority: 'P1' });
    const b = fableJob('Second', POOLS, undefined, { priority: 'P2' });
    const atLaunch: unknown[] = [];
    const l = exiting(
      launcher(idle, done, (job, input) => {
        atLaunch.push(job.id, fallbacks(job.id).length, agentsOf(job.id));
        done(job, input);
      }),
      limited('Fable limit reached'),
    );

    const s = await queue(l);

    expect(s.tickets.map((t) => [t.jobId, t.outcome])).toEqual([
      [a.jobId, 'done'],
      [b.jobId, 'done'],
    ]);
    expect(l.calls.map((c) => c.jobId)).toEqual([a.jobId, a.jobId, b.jobId]);
    expect(atLaunch).toEqual([b.jobId, 2, { 'spec-writer': 'opus' }]);
    expect(eventsOf(b.jobId, 'models.limit')).toHaveLength(0);
    expect(fallbacks(b.jobId)).toEqual(fell('Fable limit reached'));
  });

  it('a new controller reads a limit with a reset still ahead, never a past one (AC7)', async () => {
    const epoch = (ms: number) => String(Math.floor((Date.now() + ms) / 1000));
    const other = fableJob('Hit the limit earlier');
    const past = `Fable limit reached|${epoch(-3_600_000)}`;
    const { token } = claimJob(store, other.jobId, { session: 'claude-other' });
    reportLimit(store, other.jobId, { token }, { model: 'fable', text: past });

    const before = fableJob('While it was over');
    const counts: number[] = [];
    const count: Act = (job, input) => {
      counts.push(fallbacks(job.id).length);
      done(job, input);
    };
    await one(launcher(count), before.ticketId);
    expect(fallbacks(before.jobId)).toEqual([]);

    const ahead = `Fable limit reached|${epoch(3_600_000)}`;
    reportLimit(store, other.jobId, { token }, { model: 'fable', text: ahead });
    const during = fableJob('While it is spent');
    const l = launcher(count);
    const s = await one(l, during.ticketId);

    expect(s.tickets.map((t) => t.outcome)).toEqual(['done']);
    expect(l.calls).toHaveLength(1);
    expect(counts).toEqual([0, 2]);
    const until = eventsOf(other.jobId, 'models.limit').at(-1)?.payload['until'];
    expect(typeof until).toBe('string');
    expect(fallbacks(during.jobId)).toEqual(fell(ahead, until as string));
  });
});

// The account-wide path no longer ends the run at once: the controller waits and relaunches the
// same job (ticket 0180 AC4, decision 2026-11-26-controller-waits-for-limits).
describe('no other model in the pool is the account-wide path: it waits (AC8)', () => {
  const MIN = 60_000;
  /** Run the ticket with a fake sleep, recording each wait the session showed. */
  const waiting = async (ticketId: number, l: Launcher) => {
    const waits: unknown[] = [];
    const sleep = () => {
      const w = lastSession()?.wait ?? null;
      if (w !== null && JSON.stringify(waits.at(-1)) !== JSON.stringify(w)) waits.push(w);
      return Promise.resolve();
    };
    const s = await startSession(
      store,
      { mode: 'ticket', ticket: ticketId },
      { launch: l.launch, ...quick, sleep, pollMs: MIN },
    );
    return { s, waits };
  };
  const relaunched = async (ticketId: number, jobId: string) => {
    const l = exiting(launcher(idle, done), limited('Fable limit reached'));
    const { s, waits } = await waiting(ticketId, l);
    expect(s.tickets.map((t) => [t.jobId, t.outcome])).toEqual([[jobId, 'done']]);
    expect(l.calls.map((c) => c.jobId)).toEqual([jobId, jobId]);
    // No reset time is known: a probe.
    expect(waits).toMatchObject([{ reason: 'the next usage limit probe' }]);
    expect(fallbacks(jobId)).toEqual([]);
    expect(status(ticketId)).toBe('done');
  };

  it('a single-model pool waits, relaunches the same job, and records no fallback', async () => {
    const { ticketId, jobId } = fableJob('Only fable', { builder: ['fable'] }, ['builder']);
    await relaunched(ticketId, jobId);
  });

  it('all or nothing: one role without an alternative makes the job wait', async () => {
    const { ticketId, jobId } = fableJob(
      'Mixed pools',
      { builder: ['fable', 'opus'], approver: ['fable'] },
      ['builder', 'approver'],
    );
    await relaunched(ticketId, jobId);
  });

  it('a session-reported opus limit waits until its reset plus the margin', async () => {
    const { ticketId, jobId } = fableJob('Opus spent');
    const reset = Math.floor(Date.now() / 1000) + 3;
    const report: Act = (job) => {
      reportLimit(
        store,
        job.id,
        { token: job.ownerToken ?? '' },
        { model: 'opus', text: `Claude AI usage limit reached|${String(reset)}` },
      );
    };
    const l = launcher(report, done);
    const { s, waits } = await waiting(ticketId, l);
    expect(s.tickets.map((t) => t.outcome)).toEqual(['done']);
    expect(l.calls.map((c) => c.jobId)).toEqual([jobId, jobId]);
    expect(waits).toEqual([
      {
        reason: 'the usage limit to reset',
        until: new Date((reset + LIMIT_WAITS.marginSeconds) * 1000).toISOString(),
      },
    ]);
  });
});

describe('a text that names no own-allowance model behaves as before (AC9)', () => {
  it('"Opus limit reached" is an ordinary exit: no limit or fallback is recorded', async () => {
    const { ticketId, jobId } = fableJob('Opus says something');
    const l = exiting(launcher(idle, done), limited('Opus limit reached ∙ now using Sonnet'));

    const s = await one(l, ticketId);

    expect(s.tickets.map((t) => t.outcome)).toEqual(['done']);
    expect(l.calls).toHaveLength(2);
    expect(eventsOf(jobId, 'models.limit')).toEqual([]);
    expect(fallbacks(jobId)).toEqual([]);
  });
});
