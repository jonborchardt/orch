/** Telling the dead controller's Claude child from a process that reused its PID (ticket 0097). */
import { describe, expect, it } from 'vitest';

import {
  childIdentity,
  classifyStart,
  type RunnerSession,
  START_SLACK_AFTER_MS,
  START_SLACK_BEFORE_MS,
} from '../src/ops/runner-state.ts';

const T = Date.parse('2026-11-23T10:00:00.000Z');

describe('classifyStart', () => {
  it('is original inside the window, reused outside it, unknown without a reading', () => {
    expect(classifyStart(T, T)).toBe('original');
    expect(classifyStart(T, T - START_SLACK_BEFORE_MS)).toBe('original');
    expect(classifyStart(T, T + START_SLACK_AFTER_MS)).toBe('original');
    expect(classifyStart(T, T - START_SLACK_BEFORE_MS - 1)).toBe('reused');
    expect(classifyStart(T, T + START_SLACK_AFTER_MS + 1)).toBe('reused');
    expect(classifyStart(T, null)).toBe('unknown');
    expect(classifyStart(Number.NaN, T)).toBe('unknown');
  });
});

describe('childIdentity', () => {
  const session = (child: RunnerSession['child']): RunnerSession => ({
    pid: 2 ** 31 - 1,
    startedAt: new Date().toISOString(),
    beatAt: new Date().toISOString(),
    mode: 'queue',
    repo: null,
    ticket: null,
    ticketId: null,
    jobId: null,
    child,
    results: [],
    skipped: [],
    finished: null,
  });
  const now = new Date().toISOString();
  const never = (): number => {
    throw new Error('no lookup for a child that is gone');
  };

  it('is gone without a child or with a dead PID, and never looks it up then', () => {
    expect(childIdentity(session(null), never)).toBe('gone');
    expect(childIdentity(session({ pid: 2 ** 31 - 1, startedAt: now }), never)).toBe('gone');
  });

  it('asks the lookup about a live PID', () => {
    const live = session({ pid: process.pid, startedAt: now });
    expect(childIdentity(live, () => Date.parse(now))).toBe('original');
    expect(childIdentity(live, () => Date.parse(now) - 3_600_000)).toBe('reused');
    expect(childIdentity(live, () => null)).toBe('unknown');
  });
});
