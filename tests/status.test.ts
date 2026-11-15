import { describe, expect, it } from 'vitest';

import { ciSummary } from '../src/server/status.ts';
import type { CiView } from '../src/server/types.ts';

function ci(over: Partial<CiView> = {}): Omit<CiView, 'line' | 'guidance'> {
  return {
    head: null,
    current: null,
    status: null,
    checkedAt: null,
    repairs: 0,
    maxRepairs: 2,
    outcome: null,
    reason: null,
    failures: [],
    completion: null,
    ...over,
  };
}

type JobBits = Parameters<typeof ciSummary>[1];
const noPr: JobBits = { id: 'job-00000001', stage: 'build', prUrl: null, prState: null };
const withPr = (over: Partial<JobBits> = {}): JobBits => ({
  id: 'job-00000001',
  stage: 'ci',
  prUrl: 'https://github.com/x/y/pull/9',
  prState: 'draft',
  ...over,
});
const line = (job: JobBits, over: Partial<CiView>) => ciSummary(ci(over), job).line;

describe('ciSummary', () => {
  it('describes every CI state from structured fields, never from a stale verdict', () => {
    expect(line(noPr, {})).toBe('No PR yet.');
    expect(line(withPr(), {})).toBe('PR created; CI not yet observed.');
    expect(line(withPr(), { head: 'a1b2c3d4', status: 'pending', current: true })).toBe(
      'CI pending for a1b2c3d.',
    );
    expect(line(withPr(), { head: 'a1b2c3d4', status: 'passing', current: true })).toBe(
      'CI passing for a1b2c3d.',
    );
    // A green verdict for a commit that is no longer HEAD is said to be stale, in so many words.
    expect(line(withPr(), { head: 'a1b2c3d4', status: 'passing', current: false })).toContain(
      'not the current HEAD',
    );
    expect(
      line(withPr({ stage: 'build' }), { head: 'a1b2c3d4', status: 'failing', repairs: 1 }),
    ).toBe('CI failed for a1b2c3d; repair in progress (1 of 2 repairs used, stage build).');
    expect(
      line(withPr({ stage: 'needs-human' }), { head: 'a1b2c3d4', status: 'failing', repairs: 2 }),
    ).toBe('CI still failing for a1b2c3d; 2 of 2 repairs used.');
    expect(line(withPr({ stage: 'needs-human' }), { head: 'a1b2c3d4', status: 'none' })).toBe(
      'GitHub reports no checks for a1b2c3d.',
    );
    expect(
      line(withPr({ stage: 'needs-human' }), {
        head: 'a1b2c3d4',
        status: 'failing',
        outcome: 'infrastructure',
      }),
    ).toContain('did not reach a verdict');
    expect(
      line(withPr({ stage: 'needs-human' }), {
        head: 'a1b2c3d4',
        status: 'pending',
        outcome: 'closed',
      }),
    ).toContain('closed without merging');
    expect(
      line(withPr({ stage: 'needs-human' }), {
        head: 'a1b2c3d4',
        status: 'passing',
        outcome: 'outdated',
      }),
    ).toContain('moved outside the job');
    expect(
      line(withPr({ stage: 'needs-human', prState: 'merged' }), {
        head: 'a1b2c3d4',
        status: 'failing',
      }),
    ).toContain('merged outside the factory');
    const finished = withPr({ stage: 'completed' });
    expect(line(finished, { head: 'a1b2c3d4', status: 'passing', completion: 'ci' })).toBe(
      'Completed: required checks passed for a1b2c3d.',
    );
    expect(line(finished, { head: 'a1b2c3d4', status: 'none', completion: 'human' })).toBe(
      'Completed by human close-out; CI was none for a1b2c3d.',
    );
    expect(line(finished, { completion: 'legacy' })).toContain('before the ci stage existed');
  });
});
