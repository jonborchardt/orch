/**
 * `orch verify` labels likely flaky failures (decision
 * 2026-11-18-flag-likely-flaky-verification-failures): a failure in a file the job did not change,
 * or a failure followed by a pass at the same tree. A label only; runs and gates are unchanged.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { planJob } from '../src/ops/factory.ts';
import { showVerification } from '../src/ops/verify.ts';
import { board, detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import { listRuns } from '../src/storage/verification.ts';
import { type Ctx, go, start, verify } from './drive.ts';
import { commitFile, json, orch, tempDir } from './helpers.ts';
import { clone, setBaselinePolicy, store } from './verify-fixture.ts';

const TEST = 'Loading and refresh progress > shows Refreshing';

/**
 * A check that prints a Vitest FAIL line for `file` and exits 1 while the counter file outside
 * the worktree holds fewer than `fails` runs, then passes.
 */
function failThenPass(file: string | null, fails: number): void {
  const counter = join(tempDir(), 'runs');
  const script =
    "const fs = require('node:fs'); const f = process.argv[1];" +
    " const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;" +
    ' fs.writeFileSync(f, String(n + 1));' +
    ` if (n < ${String(fails)}) {` +
    (file ? ` console.error(' FAIL  ${file} > ${TEST}');` : '') +
    ' process.exit(1); }';
  setBaselinePolicy([{ id: 'unit', command: 'node', args: ['-e', script, counter] }]);
}

const flakes = (c: Ctx) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type === 'verification.flaky');

describe('verify flags likely flakes', () => {
  it('labels a failure in an unchanged file once per run, without changing the run', () => {
    failThenPass('web/src/App.test.tsx', 99);
    const c = start(store, clone);
    const r1 = verify(store, c);
    expect(r1.status).toBe('failed');
    expect(flakes(c).map((e) => e.payload)).toEqual([
      {
        runId: r1.runId,
        head: r1.head,
        tree: expect.any(String) as unknown,
        check: 'unit',
        tests: [{ file: 'web/src/App.test.tsx', name: TEST }],
        rule: 'unchanged-file',
        reason: `web/src/App.test.tsx > ${TEST} failed in run ${String(r1.runId)} at ${r1.head.slice(0, 7)}; the job did not change web/src/App.test.tsx`,
      },
    ]);
    // A label only: the run failed and is not evidence.
    expect(listRuns(store.db, c.id).map((r) => r.status)).toEqual(['failed']);
    expect(showVerification(store, c.id)?.valid).toBe(false);

    const r2 = verify(store, c);
    expect(flakes(c).map((e) => e.payload['runId'])).toEqual([r1.runId, r2.runId]);

    // Surfaced while the job is live: plan, factory status, board, and detail.
    const status = orch(store.home, tmpdir(), ['factory', 'status', c.id]);
    expect(status.out).toContain(`Flaky:   likely flaky test: web/src/App.test.tsx > ${TEST}`);
    expect(status.out).toContain(`failed in run ${String(r2.runId)}`);
    const plan = json<{ flake: { runId: number; rule: string } }>(
      orch(store.home, tmpdir(), ['--json', 'factory', 'status', c.id]),
    );
    expect(plan.flake).toMatchObject({ runId: r2.runId, rule: 'unchanged-file' });
    expect(planJob(store, c.id).flake).toMatchObject({ runId: r2.runId, rule: 'unchanged-file' });
    expect(board(store).find((r) => r.id === c.id)?.flake?.runId).toBe(r2.runId);
    const d = detail(store, c.id);
    expect(d.flake?.runId).toBe(r2.runId);
    expect(d.blocker).toBeNull();

    // A finished job shows none.
    go(store, c, 'cancel', 'done here');
    expect(board(store).find((r) => r.id === c.id)?.flake).toBeNull();
    expect(detail(store, c.id).flake).toBeNull();
    expect(planJob(store, c.id).flake).toBeNull();
    const after = orch(store.home, tmpdir(), ['factory', 'status', c.id]);
    expect(after.out).not.toContain('Flaky:');
  });

  it('labels a failure that passes on a rerun at the same tree, dismissed by that pass', () => {
    failThenPass(null, 1);
    const c = start(store, clone);
    const r1 = verify(store, c);
    expect(r1.status).toBe('failed');
    expect(flakes(c)).toEqual([]); // no parsed test: rule (b) does not fire
    const r2 = verify(store, c);
    expect(r2.status).toBe('passed');
    expect(flakes(c).map((e) => e.payload)).toEqual([
      expect.objectContaining({
        runId: r1.runId,
        check: 'unit',
        tests: [],
        rule: 'passed-on-rerun',
        reason: `check unit failed in run ${String(r1.runId)} at ${r1.head.slice(0, 7)}; run ${String(r2.runId)} passed at the same tree`,
      }),
    ]);
    expect(showVerification(store, c.id)?.valid).toBe(true);
    // Decision 2026-11-19: a newer passing run dismisses the flag; the event stays in the timeline.
    expect(detail(store, c.id).flake).toBeNull();
    expect(detail(store, c.id).events.some((e) => e.type === 'verification.flaky')).toBe(true);
    verify(store, c); // another pass does not flag again
    expect(flakes(c)).toHaveLength(1);
  });

  it('flags a run once: an unchanged-file flag is not repeated by a later pass', () => {
    failThenPass('web/src/App.test.tsx', 1);
    const c = start(store, clone);
    verify(store, c);
    expect(verify(store, c).status).toBe('passed');
    expect(flakes(c).map((e) => e.payload['rule'])).toEqual(['unchanged-file']);
  });

  it('does not flag a failure in a changed file followed by a pass at another tree', () => {
    failThenPass('src/feature.test.ts', 1);
    const c = start(store, clone);
    commitFile(c.wt, 'src/feature.test.ts', 'test 1\n');
    expect(verify(store, c).status).toBe('failed');
    commitFile(c.wt, 'src/feature.test.ts', 'test 2\n');
    expect(verify(store, c).status).toBe('passed');
    expect(flakes(c)).toEqual([]);
    expect(detail(store, c.id).flake).toBeNull();
  });
});
