import { describe, expect, it } from 'vitest';

import {
  flakeReason,
  flakeView,
  normalisePath,
  parseFailures,
  passedOnRerun,
  unchangedFile,
} from '../src/core/flake.ts';
import type { Event } from '../src/storage/schema.ts';

const REFRESHING =
  'Loading and refresh progress > shows Refreshing under the app bar only while a board poll is in flight';

describe('parseFailures', () => {
  it('reads Vitest FAIL lines, test and whole-file, through ANSI escapes', () => {
    const log = [
      ' RUN  v5.1.0 C:/w',
      ' ❯ web/src/App.test.tsx (50 tests | 1 failed) 75287ms',
      '⎯⎯⎯ Failed Tests 1 ⎯⎯⎯',
      '',
      ` FAIL  web/src/App.test.tsx > ${REFRESHING}`,
      'TestingLibraryElementError: Unable to find role="alert"',
      '\u001b[31m FAIL \u001b[39m tests/cli.test.ts > cli > \u001b[1mprints\u001b[22m\r',
      ' FAIL  tests/broken.test.ts [ tests/broken.test.ts ]',
      ' FAIL  tests/bare.test.ts',
      ` FAIL  web/src/App.test.tsx > ${REFRESHING}`,
    ].join('\n');
    expect(parseFailures(log)).toEqual([
      { file: 'web/src/App.test.tsx', name: REFRESHING },
      { file: 'tests/cli.test.ts', name: 'cli > prints' },
      { file: 'tests/broken.test.ts', name: null },
      { file: 'tests/bare.test.ts', name: null },
    ]);
  });

  it('strips OSC sequences and other control characters from test names', () => {
    const log =
      ' FAIL  a.test.ts > \u001b]0;title\u0007x\u001b]8;;http://e\u001b\\y\u0000\u0008\u009bz';
    expect(parseFailures(log)).toEqual([{ file: 'a.test.ts', name: 'xyz' }]);
  });

  it('reads a long run of spaces in linear time', () => {
    const spaces = ' '.repeat(200_000);
    const started = Date.now();
    expect(parseFailures(`FAIL${spaces}a.test.ts${spaces}x\n${spaces}`)).toEqual([
      { file: `a.test.ts${spaces}x`, name: null },
    ]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns [] without FAIL lines', () => {
    expect(parseFailures('Test Files  1 passed (1)\n')).toEqual([]);
    expect(parseFailures('')).toEqual([]);
  });
});

describe('normalisePath', () => {
  it('joins the cwd, converts backslashes, and collapses ./ and . segments', () => {
    expect(normalisePath('.', 'web/src/App.test.tsx')).toBe('web/src/App.test.tsx');
    expect(normalisePath('web', 'src/App.test.tsx')).toBe('web/src/App.test.tsx');
    expect(normalisePath('.', 'web\\src\\App.test.tsx')).toBe('web/src/App.test.tsx');
    expect(normalisePath('./web/.', './src/./App.test.tsx')).toBe('web/src/App.test.tsx');
  });

  it('refuses absolute paths and paths that leave the worktree', () => {
    expect(normalisePath('.', '../x.test.ts')).toBeNull();
    expect(normalisePath('web', 'src/../../x.test.ts')).toBeNull();
    expect(normalisePath('.', '/abs/x.test.ts')).toBeNull();
    expect(normalisePath('.', 'C:\\w\\x.test.ts')).toBeNull();
  });
});

describe('unchangedFile (rule b)', () => {
  const app = [{ file: 'web/src/App.test.tsx', name: REFRESHING }];
  it('fires only when every test file is outside the changed list', () => {
    expect(unchangedFile(app, '.', ['src/ops/verify.ts'])).toBe(true);
    expect(unchangedFile(app, '.', ['web/src/App.test.tsx'])).toBe(false);
    const two = [...app, { file: 'tests/verify.test.ts', name: null }];
    expect(unchangedFile(two, '.', ['tests/verify.test.ts'])).toBe(false);
  });

  it('does not fire without parsed tests', () => {
    expect(unchangedFile([], '.', [])).toBe(false);
  });

  it('compares worktree-relative paths', () => {
    const rel = [{ file: 'src/App.test.tsx', name: 'x' }];
    expect(unchangedFile(rel, 'web', ['web/src/App.test.tsx'])).toBe(false);
    const back = [{ file: 'web\\src\\App.test.tsx', name: 'x' }];
    expect(unchangedFile(back, '.', ['web/src/App.test.tsx'])).toBe(false);
    const dot = [{ file: './web/src/App.test.tsx', name: 'x' }];
    expect(unchangedFile(dot, '.', ['web/src/App.test.tsx'])).toBe(false);
    expect(unchangedFile(dot, '.', ['src/other.ts'])).toBe(true);
  });

  it('treats an escaping or absolute path as changed', () => {
    expect(unchangedFile([{ file: '../x.test.ts', name: 'x' }], '.', [])).toBe(false);
    expect(unchangedFile([{ file: '/abs/x.test.ts', name: 'x' }], '.', [])).toBe(false);
  });
});

describe('passedOnRerun (rule a)', () => {
  const failed = { id: 1, tree: 't1', status: 'failed', configFingerprint: 'p' };
  const pass = { id: 2, tree: 't1', status: 'passed', configFingerprint: 'p' };
  it('fires for a failed run followed by a pass at the same tree', () => {
    expect(passedOnRerun(failed, pass)).toBe(true);
  });
  it('does not fire for another tree or policy, an earlier pass, or a run that did not fail', () => {
    expect(passedOnRerun(failed, { ...pass, tree: 't2' })).toBe(false);
    expect(passedOnRerun(failed, { ...pass, configFingerprint: 'q' })).toBe(false);
    expect(passedOnRerun({ ...failed, id: 3 }, pass)).toBe(false);
    expect(passedOnRerun({ ...failed, status: 'interrupted' }, pass)).toBe(false);
  });
});

describe('flakeReason and flakeView', () => {
  it('names the first test, the run, and the short head; or the check', () => {
    const run = { id: 12, head: 'abc1234def567' };
    expect(
      flakeReason(run, 'check', [{ file: 'web/src/App.test.tsx', name: REFRESHING }], 'why'),
    ).toBe(`web/src/App.test.tsx > ${REFRESHING} failed in run 12 at abc1234; why`);
    expect(flakeReason(run, 'check', [], 'why')).toBe(
      'check check failed in run 12 at abc1234; why',
    );
  });

  it('shows the newest event for a live job only', () => {
    const e = {
      id: 1,
      jobId: 'job-1',
      type: 'verification.flaky',
      payload: {
        runId: 3,
        head: 'h',
        tree: 't',
        check: 'check',
        tests: [],
        rule: 'passed-on-rerun',
        reason: 'r',
      },
      actor: null,
      createdAt: '2026-11-18T00:00:00.000Z',
    } satisfies Event;
    expect(flakeView({ status: 'running' }, e)).toEqual({
      runId: 3,
      head: 'h',
      check: 'check',
      tests: [],
      rule: 'passed-on-rerun',
      reason: 'r',
      at: '2026-11-18T00:00:00.000Z',
    });
    expect(flakeView({ status: 'running' }, undefined)).toBeNull();
    expect(flakeView({ status: 'completed' }, e)).toBeNull();
    expect(flakeView({ status: 'cancelled' }, e)).toBeNull();
    const many = Array.from({ length: 40 }, (_, i) => ({
      file: `t${String(i)}.test.ts`,
      name: null,
    }));
    const view = flakeView({ status: 'running' }, { ...e, payload: { ...e.payload, tests: many } });
    expect(view?.tests).toEqual(many.slice(0, 5));
  });
});
