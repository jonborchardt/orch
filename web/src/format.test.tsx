import { describe, expect, it } from 'vitest';

import type { JobDetailView } from '../../src/server/types.ts';
import { eventSummary, localTime } from './format.ts';

type Event = JobDetailView['events'][number];
const ev = (type: string, payload: unknown): Event => ({
  id: 1,
  jobId: 'job-00000003',
  type,
  payload: payload as Event['payload'],
  actor: null,
  createdAt: '2026-11-13T08:00:00.000Z',
});
const HEAD = '92e988a0c1d2e3f4';

/** Every type with its own wording: the payload its emitter records, and the line it reads as. */
const NAMED: [string, Record<string, unknown>, string][] = [
  ['stage.started', { stage: 'build' }, 'stage.started: build'],
  ['stage.completed', { stage: 'review', round: 2 }, 'stage.completed: review, round 2'],
  [
    'stage.failed',
    { stage: 'build', reason: 'tests\nfailed' },
    'stage.failed: build, tests failed',
  ],
  [
    'job.blocked',
    { from: 'approve', reason: 'a human must decide', choices: [] },
    'job.blocked: from approve, a human must decide',
  ],
  ['job.resumed', { to: 'build', maxRounds: 4 }, 'job.resumed: to build'],
  [
    'job.reworked',
    { from: 'ci', reason: 'CI failed', ciRepairs: 1, maxRounds: 4 },
    'job.reworked: from ci, CI failed',
  ],
  ['job.cancelled', { stage: 'spec', reason: 'duplicate' }, 'job.cancelled: spec, duplicate'],
  ['job.interrupted', { previousSession: 'claude-1', expired: true }, 'job.interrupted'],
  [
    'ci.observed',
    { ciStatus: 'pending', prState: 'draft', head: HEAD, outcome: 'passing', polls: 5, checks: [] },
    'ci.observed: passing @92e988a, poll 5',
  ],
  [
    'verification.completed',
    { runId: 12, status: 'passed' },
    'verification.completed: run 12, passed',
  ],
  [
    'review.recorded',
    { round: 1, reviewer: 'security', verdict: 'changes' },
    'review.recorded: round 1, security: changes',
  ],
  [
    'artifact.registered',
    { path: 'spec.md', stage: 'spec', sha256: 'ab', head: null },
    'artifact.registered: spec.md',
  ],
  ['artifact.replaced', { path: 'build.md', previousSha256: 'cd' }, 'artifact.replaced: build.md'],
  ['pr.recorded', { url: 'https://github.com/x/y/pull/9', state: 'draft' }, 'pr.recorded: draft'],
  [
    'pr.merged',
    { head: HEAD, ok: false, error: 'not mergeable' },
    'pr.merged: merge refused @92e988a, not mergeable',
  ],
  ['pr.observed', { state: 'merged', head: HEAD, mergeable: null }, 'pr.observed: merged @92e988a'],
  [
    'branch.pushed',
    { branch: 'factory/job-1-x', head: HEAD },
    'branch.pushed: factory/job-1-x @92e988a',
  ],
  [
    'session.attached',
    { provider: 'claude-code', ref: '565e2b23-152d-4533-b6b3-e1d4981c7297', cwd: null },
    'session.attached: claude-code, 565e2b23',
  ],
  [
    'runner.session',
    { outcome: 'exited', exitCode: 0, signal: null, seconds: 90 },
    'runner.session: exited, exit 0',
  ],
  [
    'runner.stopped',
    { outcome: 'stopped', code: 'needs-human', reason: 'waiting for a decision' },
    'runner.stopped: stopped, needs-human, waiting for a decision',
  ],
];

describe('eventSummary (ticket 0018)', () => {
  it.each(NAMED)('%s reads the fields it records', (type, payload, line) => {
    expect(eventSummary(ev(type, payload))).toBe(line);
  });

  it('reads a confirmed merge, a review without a verdict, and a session link', () => {
    expect(eventSummary(ev('pr.merged', { head: HEAD, ok: true, error: null }))).toBe(
      'pr.merged: merged @92e988a',
    );
    expect(eventSummary(ev('review.recorded', { round: 1, reviewer: 'security' }))).toBe(
      'review.recorded: round 1, security: pending',
    );
    expect(
      eventSummary(
        ev('session.attached', {
          provider: 'vscode-agents',
          ref: 'agent-host-session://h/abcdef0123',
        }),
      ),
    ).toBe('session.attached: vscode-agents, abcdef01');
  });

  it('falls back to the type and its short scalar fields', () => {
    expect(
      eventSummary(
        ev('mail.sent', {
          ok: true,
          count: 2,
          to: 'a@b.c',
          long: 'x'.repeat(61),
          nested: { a: 1 },
          none: null,
        }),
      ),
    ).toBe('mail.sent: ok=true, count=2, to=a@b.c');
    expect(eventSummary(ev('job.note', {}))).toBe('job.note');
    // A short value with a newline still reads on one line.
    expect(eventSummary(ev('job.note', { text: ' two\n  lines ' }))).toBe(
      'job.note: text=two lines',
    );
  });

  it('never throws on a malformed payload and still starts with the type', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'text',
      42,
      true,
      [],
      [1, 2],
      {},
      // Numbers where strings are expected, and the reverse.
      { stage: 7, from: 1, to: 2, reason: 3, head: 4, branch: 5, ref: 6, path: 8, state: 9 },
      { round: 'two', polls: 'many', runId: 'x', exitCode: 'one', ok: 'yes' },
      // Nested objects, arrays, and nulls in every field a summary reads.
      Object.fromEntries(
        [
          'stage',
          'round',
          'from',
          'to',
          'reason',
          'outcome',
          'ciStatus',
          'head',
          'polls',
          'runId',
          'status',
          'reviewer',
          'verdict',
          'path',
          'state',
          'ok',
          'error',
          'branch',
          'provider',
          'ref',
          'code',
          'exitCode',
        ].map((k, i) => [k, [{ a: { b: 1 } }, [1], null][i % 3]]),
      ),
    ];
    for (const type of [...NAMED.map(([t]) => t), 'other.type']) {
      for (const payload of malformed) {
        const line = eventSummary(ev(type, payload));
        expect(line.startsWith(type)).toBe(true);
        expect(line).not.toMatch(/\n|\[object|undefined|null/);
      }
    }
  });
});

describe('localTime', () => {
  it('is the local date and time with a zone, never the ISO string', () => {
    const iso = '2026-11-13T08:05:00.000Z';
    const text = localTime(iso);
    expect(text).toBe(new Date(iso).toLocaleString(undefined, { timeZoneName: 'short' }));
    expect(text).not.toBe(iso);
    // A zone marker after the time: an abbreviation (UTC, CST) or an offset (GMT-6).
    expect(text).toMatch(/\d{1,2}:\d{2}.*\s[A-Z]{2,5}([+-]\d{1,2}(:\d{2})?)?$/);
    expect(localTime('not a date')).toBe('not a date');
  });
});
