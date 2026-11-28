/**
 * The pure rule comparing a head's culprit checks with the base tip's checks (ticket 0228).
 */
import { describe, expect, it } from 'vitest';
import { baseVerdict, type CiCheck } from '../src/core/ci.ts';

let id = 0;
function check(name: string, conclusion: string, status = 'completed', suiteId = 1): CiCheck {
  id += 1;
  return { id, suiteId, name, status, conclusion, url: null, jobId: id };
}

describe('baseVerdict (pure)', () => {
  it('failing when every culprit completed without passing on the base', () => {
    const r = baseVerdict(['test', 'e2e'], [check('test', 'failure'), check('e2e', 'cancelled')]);
    expect(r.verdict).toBe('failing');
    expect(r.checks.map((c) => [c.name, c.conclusion])).toEqual([
      ['test', 'failure'],
      ['e2e', 'cancelled'],
    ]);
  });

  it('pending when a culprit is queued or running there and the rest do not all fail', () => {
    expect(baseVerdict(['test'], [check('test', '', 'in_progress')]).verdict).toBe('pending');
    expect(
      baseVerdict(['test', 'e2e'], [check('test', 'failure'), check('e2e', '', 'queued')]).verdict,
    ).toBe('pending');
  });

  it('clear when the base passes, never reports the check, or shares only some culprits', () => {
    expect(baseVerdict(['test'], [check('test', 'success')]).verdict).toBe('clear');
    expect(baseVerdict(['test'], [check('lint', 'failure')]).verdict).toBe('clear');
    expect(baseVerdict(['test'], []).verdict).toBe('clear');
    expect(baseVerdict([], [check('test', 'failure')]).verdict).toBe('clear');
    expect(
      baseVerdict(['test', 'e2e'], [check('test', 'failure'), check('e2e', 'success')]).verdict,
    ).toBe('clear');
  });

  it('only the newest attempt of a check in one suite counts', () => {
    const old = check('test', 'failure');
    const rerun = check('test', 'success');
    expect(baseVerdict(['test'], [rerun, old]).verdict).toBe('clear');
    const passed = check('test', 'success');
    const failedAgain = check('test', 'failure');
    expect(baseVerdict(['test'], [passed, failedAgain])).toMatchObject({
      verdict: 'failing',
      checks: [{ id: failedAgain.id }],
    });
  });
});
