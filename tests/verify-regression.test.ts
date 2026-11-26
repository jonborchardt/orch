/**
 * Bug tickets prove the fix (ticket 0156): with `verification.regression` in the policy, a passed
 * `orch verify` of a bug job runs the job's changed tests with its other changes reverted to the
 * merge base (red) and at HEAD (green), and records the attempt. Evidence only: never a gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import { jobs, regressionRuns } from '../src/storage/schema.ts';
import { createTicket } from '../src/storage/tickets.ts';
import { type Ctx, head, POLICY, start, verify } from './drive.ts';
import { commitFile, gitIn, json, orch } from './helpers.ts';
import { clone, inBuild, store } from './verify-fixture.ts';

const BUGGY = 'exports.add = (a, b) => a - b;\n';
const FIXED = 'exports.add = (a, b) => a + b;\n';
const ADD_TEST =
  "const test = require('node:test');\n" +
  "const assert = require('node:assert');\n" +
  "const fs = require('node:fs');\n" +
  "const { add } = require('../src/lib.js');\n" +
  "console.log('HEAD-VERSION new=' + fs.existsSync('src/new.js') + ' old=' + fs.existsSync('src/old.js'));\n" +
  "test('add', () => assert.strictEqual(add(1, 2), 3));\n";

/** Baseline on main: the bug, a file the job deletes, and a policy with `regression`. */
function baseline(
  regression: Record<string, unknown> | null = { command: 'node', args: ['--test'] },
) {
  commitFile(clone, 'src/lib.js', BUGGY);
  commitFile(clone, 'src/old.js', 'exports.old = 1;\n');
  const policy = regression ? { verification: { ...POLICY.verification, regression } } : POLICY;
  commitFile(clone, 'factory.json', JSON.stringify(policy, null, 2) + '\n', 'policy');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

function job(type: 'bug' | 'feature' = 'bug'): Ctx {
  const c = start(store, clone);
  const t = createTicket(store, { title: 'Add is wrong', type, repo: 'r', repoPath: '/r' });
  store.db.update(jobs).set({ ticketId: t.id }).where(eq(jobs.id, c.id)).run();
  inBuild(c);
  return c;
}

const rows = (c: Ctx) =>
  store.db.select().from(regressionRuns).where(eq(regressionRuns.jobId, c.id)).all();

/** AC9: after every attempt the worktree is clean at the same HEAD. */
function expectClean(c: Ctx, sha: string) {
  expect(gitIn(c.wt, 'status', '--porcelain')).toBe('');
  expect(head(c.wt)).toBe(sha);
}

const log = (c: Ctx, runId: number, side: string) =>
  join(jobArtifactDir(c.id, store.paths), 'verification', String(runId), `regression-${side}.log`);

describe('bug-fix regression evidence', () => {
  it('records passed: red at the base with only non-test changes reverted, green at HEAD', () => {
    baseline();
    const c = job();
    commitFile(c.wt, 'src/lib.js', FIXED);
    commitFile(c.wt, 'src/new.js', 'exports.n = 1;\n');
    gitIn(c.wt, 'rm', '-q', 'src/old.js');
    gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'drop old');
    const sha = commitFile(c.wt, 'tests/lib.test.js', ADD_TEST);
    const base = gitIn(c.wt, 'merge-base', 'origin/main', 'HEAD');
    const r = verify(store, c);
    expect(r.status).toBe('passed');
    expect(r.regression).toMatchObject({
      status: 'passed',
      files: ['tests/lib.test.js'],
      base,
      head: sha,
      green: 0,
    });
    expect(r.regression?.red).not.toBe(0);
    expect(r.regression?.red).not.toBeNull();
    const [row] = rows(c);
    expect(row).toMatchObject({
      runId: r.runId,
      mergeBase: base,
      head: sha,
      status: 'passed',
      testFiles: ['tests/lib.test.js'],
      greenExit: 0,
      redLog: `verification/${String(r.runId)}/regression-red.log`,
    });
    // AC10: the test ran at its HEAD version; the job's added file was absent, its deleted one back.
    const red = readFileSync(log(c, r.runId ?? 0, 'red'), 'utf8');
    expect(red).toContain('HEAD-VERSION new=false old=true');
    expect(readFileSync(log(c, r.runId ?? 0, 'green'), 'utf8')).toContain(
      'HEAD-VERSION new=true old=false',
    );
    expectClean(c, sha);
  });

  it('records not-red when the test passes at the base; verify still passes (CLI exit 0)', () => {
    baseline();
    const c = job();
    commitFile(c.wt, 'src/lib.js', FIXED);
    commitFile(c.wt, 'tests/ok.test.js', "require('node:test')('ok', () => {});\n");
    const sha = head(c.wt);
    const res = orch(store.home, tmpdir(), ['--json', 'verify', c.id, '--token', c.token]);
    expect(res.code).toBe(0);
    const out = json<{ status: string; reused: boolean; regression: Record<string, unknown> }>(res);
    expect(out.status).toBe('passed');
    expect(out.regression).toMatchObject({
      status: 'not-red',
      files: ['tests/ok.test.js'],
      head: sha,
      red: 0,
      green: null,
    });
    expect(out.regression['base']).toMatch(/^[0-9a-f]{40}$/);
    expectClean(c, sha);
    // A reused run runs nothing and reports the recorded attempt, in text too (AC12).
    const text = orch(store.home, tmpdir(), ['verify', c.id, '--token', c.token]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/regression/);
    expect(text.out).toMatch(/not-red/);
    expect(text.out).toContain('tests/ok.test.js');
    expect(rows(c)).toHaveLength(1);
  });

  it('records no-tests for a bug job that changes no test file, and runs nothing', () => {
    baseline();
    const c = job();
    const sha = commitFile(c.wt, 'src/lib.js', FIXED);
    const r = verify(store, c);
    expect(r.status).toBe('passed');
    expect(r.regression).toMatchObject({ status: 'no-tests', files: [], red: null, green: null });
    expect(rows(c)).toHaveLength(1);
    expect(existsSync(log(c, r.runId ?? 0, 'red'))).toBe(false);
    expectClean(c, sha);
  });

  it('records exempt when only Markdown changed, and runs nothing', () => {
    baseline();
    const c = job();
    const sha = commitFile(c.wt, 'docs/fix.md', '# note\n');
    const r = verify(store, c);
    expect(r.regression).toMatchObject({ status: 'exempt', red: null, green: null });
    expect(rows(c)[0]?.status).toBe('exempt');
    expect(existsSync(log(c, r.runId ?? 0, 'red'))).toBe(false);
    expectClean(c, sha);
  });

  it('records nothing for a feature job, or a bug job whose policy has no regression', () => {
    baseline();
    const feature = job('feature');
    commitFile(feature.wt, 'src/lib.js', FIXED);
    const sha = commitFile(feature.wt, 'tests/lib.test.js', ADD_TEST);
    expect(verify(store, feature)).toMatchObject({ status: 'passed', regression: null });
    expect(rows(feature)).toHaveLength(0);
    expectClean(feature, sha);

    commitFile(clone, 'factory.json', JSON.stringify(POLICY, null, 2) + '\n', 'no regression');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const bug = job();
    commitFile(bug.wt, 'src/lib.js', FIXED);
    const sha2 = commitFile(bug.wt, 'tests/lib.test.js', ADD_TEST);
    expect(verify(store, bug)).toMatchObject({ status: 'passed', regression: null });
    expect(rows(bug)).toHaveLength(0);
    expectClean(bug, sha2);
  });

  it('a red run that times out still leaves the worktree clean at HEAD', () => {
    baseline({ command: 'node', args: ['--test'], timeoutMs: 1000 });
    const c = job();
    commitFile(c.wt, 'src/lib.js', FIXED);
    const hang =
      "const { add } = require('../src/lib.js');\n" +
      'if (add(1, 2) !== 3) setInterval(() => {}, 1000);\n' +
      "require('node:test')('add', () => {});\n";
    const sha = commitFile(c.wt, 'tests/hang.test.js', hang);
    const r = verify(store, c);
    expect(r.status).toBe('passed');
    expect(r.regression).toMatchObject({ status: 'passed', red: null, green: 0 });
    expect(readFileSync(log(c, r.runId ?? 0, 'red'), 'utf8')).toContain('status: timed-out');
    expectClean(c, sha);
  });
});
