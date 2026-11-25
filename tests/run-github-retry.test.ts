/**
 * The factory controller rides out a transient `gh pr merge` failure with a bounded backoff
 * (decision 2026-11-25-bounded-github-retry); a schedule of zero-second waits keeps it quick.
 * Uses tests/run-fixture.ts.
 */
import { describe, expect, it } from 'vitest';

import { ticketKey } from '../src/core/tickets.ts';
import { startSession } from '../src/ops/run.ts';
import {
  done,
  eventsOf,
  jobsOf,
  launcher,
  merges,
  quick,
  shim,
  status,
  store,
  ticket,
} from './run-fixture.ts';

/** The ticket 0157 text, verbatim. */
const GRAPHQL = 'GraphQL: Something went wrong while executing your query';
const BACKOFF = [0, 0];

const queue = () =>
  startSession(
    store,
    { mode: 'queue', repo: null },
    { launch: launcher(done).launch, ...quick, githubBackoff: BACKOFF },
  );
const failedMerges = (jobId: string) =>
  eventsOf(jobId, 'pr.merged').filter((e) => e.payload['ok'] === false);

describe('a transient GitHub failure at merge', () => {
  it('is retried until the merge goes through, and the queue goes on', async () => {
    const first = ticket('Flaky GitHub', { priority: 'P1' });
    const second = ticket('Next', { priority: 'P2' });
    shim.write({ fail: 'pr merge', failMessage: GRAPHQL, failTimes: 2 });

    const s = await queue();

    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [first, 'done'],
      [second, 'done'],
    ]);
    expect(status(first)).toBe('done');
    const jobId = jobsOf(first)[0]?.id ?? '';
    expect(failedMerges(jobId)).toHaveLength(2);
    expect(failedMerges(jobId)[0]?.payload['error']).toBe(GRAPHQL);
    // Two failed calls and one that merged for the first ticket, one for the second.
    expect(merges()).toHaveLength(4);
  });

  it('that followed a merge GitHub made is recorded as merged, without a second call', async () => {
    const id = ticket('Merged despite the error');
    shim.write({ failAfter: 'pr merge', failMessage: 'HTTP 502: Bad Gateway' });

    const s = await queue();

    expect(s.tickets[0]).toMatchObject({ ticketId: id, outcome: 'done' });
    expect(status(id)).toBe('done');
    expect(merges()).toHaveLength(1);
  });

  it('every time ends the run as github-refused after the budget', async () => {
    const first = ticket('GitHub down', { priority: 'P1' });
    const second = ticket('Never started', { priority: 'P2' });
    shim.write({ fail: 'pr merge', failMessage: GRAPHQL });

    const s = await queue();

    const attempts = BACKOFF.length + 1;
    expect(s.tickets).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({
      ticketId: first,
      outcome: 'blocked',
      code: 'github-refused',
    });
    expect(s.tickets[0]?.reason).toContain(`in ${String(attempts)} attempts`);
    expect(s.tickets[0]?.next).toContain('tries again');
    expect(s.reason).toContain(`ticket ${ticketKey(first)} is blocked: github-refused`);
    expect(merges()).toHaveLength(attempts);
    const jobId = jobsOf(first)[0]?.id ?? '';
    expect(failedMerges(jobId)).toHaveLength(attempts);
    expect(eventsOf(jobId, 'runner.stopped').at(-1)?.payload).toMatchObject({
      code: 'github-refused',
      reason: s.tickets[0]?.reason,
    });
    expect(jobsOf(second)).toHaveLength(0);
  });
});
