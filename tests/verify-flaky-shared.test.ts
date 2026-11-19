/**
 * Todo 0067 (decision 2026-11-19-integrate-base-before-reworking-unchanged-failures): a failure
 * only in files the job did not change, with a moved base, plans "integrate base, then verify
 * again"; the same test failing in several jobs reads as one machine-wide cause; a newer passing
 * run drops the flag. Labels only: runs, validity, and blockers are unchanged.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reportBody } from '../src/core/mail-report.ts';
import { planJob } from '../src/ops/factory.ts';
import { showVerification } from '../src/ops/verify.ts';
import { board, detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import { listRuns } from '../src/storage/verification.ts';
import { type Ctx, start, verify } from './drive.ts';
import { commitFile, gitIn, orch, tempDir } from './helpers.ts';
import { clone, inBuild, setBaselinePolicy, store } from './verify-fixture.ts';

const FILE = 'web/src/App.test.tsx';
const TEST = 'Loading and refresh progress > shows Refreshing';

/** Run n of the check fails (printing a Vitest FAIL line for FILE) when `fails[n]` is 1; the last entry repeats. */
function failPattern(fails: number[]): void {
  const counter = join(tempDir(), 'runs');
  const script =
    "const fs = require('node:fs'); const f = process.argv[1]; const p = JSON.parse(process.argv[2]);" +
    " const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;" +
    ' fs.writeFileSync(f, String(n + 1));' +
    ` if ((p[n] ?? p[p.length - 1]) === 1) { console.error(' FAIL  ${FILE} > ${TEST}'); process.exit(1); }`;
  setBaselinePolicy([
    { id: 'unit', command: 'node', args: ['-e', script, counter, JSON.stringify(fails)] },
  ]);
}

/** Commit something unrelated on the base branch, as another merged PR would. */
function advanceBase(): void {
  commitFile(clone, `other-${String(Date.now())}.txt`, 'x\n', 'someone else');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

const flakes = (c: Ctx) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type === 'verification.flaky');
const INTEGRATE = (c: Ctx) => `orch worktree integrate ${c.id} --token <token>`;

describe('integrate base first', () => {
  it('plans integrate then verify when base moved and the failure is in an unchanged file', () => {
    failPattern([1]);
    const c = start(store, clone);
    inBuild(c);

    // Base not moved: today's wording and commands.
    const r1 = verify(store, c);
    expect(r1.status).toBe('failed');
    expect(r1.hint).toContain('Fix, commit, and run orch verify again.');
    let plan = planJob(store, c.id);
    expect(plan.flake).toMatchObject({ runId: r1.runId, rule: 'unchanged-file', sharedWith: [] });
    expect(plan.commands.some((x) => x.startsWith('orch worktree integrate'))).toBe(false);
    expect(plan.reason).toMatch(/^Implement spec\.md/);

    advanceBase();
    const r2 = verify(store, c);
    expect(r2.status).toBe('failed');
    expect(r2.hint).toContain('integrate base');
    expect(r2.hint).toContain('verify again');
    expect(r2.hint).not.toContain('Fix, commit');
    plan = planJob(store, c.id);
    expect(plan.stage).toBe('build');
    expect(plan.reason).toContain('integrate base');
    expect(plan.reason).toContain('verify again');
    const integrate = plan.commands.indexOf(
      INTEGRATE(c) + '   # base moved; verify again after it',
    );
    const verifyAt = plan.commands.indexOf(`orch verify ${c.id} --token <token>`);
    expect(integrate).toBeGreaterThanOrEqual(0);
    expect(integrate).toBeLessThan(verifyAt);

    // Still a label: the run failed, is not evidence, and nothing blocks the job.
    expect(listRuns(store.db, c.id).map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(showVerification(store, c.id)?.valid).toBe(false);
    expect(detail(store, c.id).blocker).toBeNull();
  });

  it('keeps the rework wording when the job changed the failing file', () => {
    failPattern([1]);
    const c = start(store, clone);
    inBuild(c);
    commitFile(c.wt, FILE, 'changed by the job\n');
    advanceBase();
    const r = verify(store, c);
    expect(r.status).toBe('failed');
    expect(r.hint).toContain('Fix, commit, and run orch verify again.');
    expect(flakes(c)).toEqual([]);
    const plan = planJob(store, c.id);
    expect(plan.worktree?.behind).toBeGreaterThan(0);
    expect(plan.flake).toBeNull();
    expect(plan.commands.some((x) => x.startsWith('orch worktree integrate'))).toBe(false);
  });
});

describe('one machine-wide cause', () => {
  it('names the other jobs failing the same test, once, on every surface and in mail', () => {
    failPattern([1]);
    const a = start(store, clone, 'Job A');
    const b = start(store, clone, 'Job B');
    verify(store, a);
    expect(flakes(a)[0]?.payload['reason']).not.toContain('machine-wide');
    verify(store, b);
    const why = flakes(b)[0]?.payload['reason'];
    expect(why).toContain(`the same test also failed in ${a.id}, likely machine-wide`);

    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      expect(planJob(store, self.id).flake?.sharedWith).toEqual([other.id]);
      expect(board(store).find((r) => r.id === self.id)?.flake?.sharedWith).toEqual([other.id]);
      expect(detail(store, self.id).flake?.sharedWith).toEqual([other.id]);
    }
    const out = orch(store.home, tmpdir(), ['factory', 'status', b.id]).out;
    const lines = out.split('\n').filter((l) => l.startsWith('Flaky:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('machine-wide');
    expect(lines[0]).toContain(a.id);

    // Mail carries the event reason, and so the shared note.
    const body = reportBody(getJob(store.db, b.id), flakes(b));
    expect(body).toContain(`likely flaky test: ${String(why)}`);
    expect(body).toContain(a.id);
  });
});

describe('dismissal', () => {
  it('drops the flag once a newer run passes, and shows a later failure again', () => {
    failPattern([1, 0, 1]);
    const c = start(store, clone);
    const r1 = verify(store, c);
    expect(r1.status).toBe('failed');
    expect(planJob(store, c.id).flake?.runId).toBe(r1.runId);
    expect(verify(store, c).status).toBe('passed');

    expect(planJob(store, c.id).flake).toBeNull();
    expect(board(store).find((r) => r.id === c.id)?.flake).toBeNull();
    expect(detail(store, c.id).flake).toBeNull();
    expect(orch(store.home, tmpdir(), ['factory', 'status', c.id]).out).not.toContain('Flaky:');
    expect(flakes(c)).toHaveLength(1); // the event stays in the timeline
    expect(detail(store, c.id).events.some((e) => e.type === 'verification.flaky')).toBe(true);

    // A new commit fails again with no pass after it: shown again.
    commitFile(c.wt, 'notes.txt', 'n\n');
    const r3 = verify(store, c);
    expect(r3.status).toBe('failed');
    expect(planJob(store, c.id).flake?.runId).toBe(r3.runId);
  });
});
