/**
 * Bug tickets prove the fix (ticket 0162): under a policy with `verification.regression`, a bug
 * job's verification is valid only with a `passed` or `exempt` regression record for HEAD, so
 * every gate that asks `verificationStatus` refuses it otherwise.
 */
import { tmpdir } from 'node:os';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { effectivePolicy, verificationStatus } from '../src/ops/verify.ts';
import { worktreeOf } from '../src/ops/tree.ts';
import { getJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { createTicket } from '../src/storage/tickets.ts';
import { add, type Ctx, go, POLICY, start, verify } from './drive.ts';
import { commitFile, gitIn, orch } from './helpers.ts';
import { clone, inBuild, store } from './verify-fixture.ts';

const FIXED = 'exports.add = (a, b) => a + b;\n';
const ADD_TEST =
  "const { add } = require('../src/lib.js');\n" +
  "require('node:test')('add', () => require('node:assert').strictEqual(add(1, 2), 3));\n";
const OK_TEST = "require('node:test')('ok', () => {});\n";
const FAILING_TEST = "require('node:test')('no', () => { throw new Error('x'); });\n";

function baseline(regression = true) {
  if (regression) commitFile(clone, 'src/lib.js', 'exports.add = (a, b) => a - b;\n');
  const regr = { command: 'node', args: ['--test'] };
  const policy = regression
    ? { verification: { ...POLICY.verification, regression: regr } }
    : POLICY;
  commitFile(clone, 'factory.json', JSON.stringify(policy, null, 2) + '\n', 'policy');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

function job(type: 'bug' | 'feature' | null = 'bug'): Ctx & { ticket: number } {
  const c = start(store, clone);
  let ticket = 0;
  if (type) {
    ticket = createTicket(store, { title: 'Add is wrong', type, repo: 'r', repoPath: '/r' }).id;
    store.db.update(jobs).set({ ticketId: ticket }).where(eq(jobs.id, c.id)).run();
  }
  inBuild(c);
  return { ...c, ticket };
}

function status(c: Ctx) {
  const j = getJob(store.db, c.id);
  const wt = worktreeOf(j);
  if (!wt) throw new Error('no worktree');
  return verificationStatus(store, j, wt);
}

/** Register build.md and complete build. */
function completeBuild(c: Ctx) {
  add(store, c, 'build.md');
  return go(store, c, 'complete');
}

describe('bug-fix regression gate', () => {
  it('AC1, AC3: a passed record is valid and build completes; a new commit invalidates it', () => {
    baseline();
    const c = job();
    commitFile(c.wt, 'src/lib.js', FIXED);
    commitFile(c.wt, 'tests/lib.test.js', ADD_TEST);
    expect(verify(store, c)).toMatchObject({ status: 'passed', regression: { status: 'passed' } });
    expect(status(c)).toMatchObject({ valid: true, reason: null });
    expect(() => completeBuild(c)).not.toThrow();
    const sha = commitFile(c.wt, 'src/more.js', 'exports.m = 1;\n');
    expect(status(c).reason).toContain(`HEAD is ${sha.slice(0, 7)}`);
  });

  it('AC2: not-green and no-tests records are refused with their reason', () => {
    baseline();
    const green = job();
    commitFile(green.wt, 'tests/bad.test.js', FAILING_TEST);
    expect(verify(store, green)).toMatchObject({
      status: 'failed',
      regression: { status: 'not-green' },
    });
    expect(status(green)).toMatchObject({ valid: false });
    expect(status(green).reason).toContain('test failed at HEAD');
    expect(() => completeBuild(green)).toThrow(/test failed at HEAD/);

    const none = job();
    commitFile(none.wt, 'src/lib.js', FIXED);
    expect(verify(store, none)).toMatchObject({
      status: 'failed',
      regression: { status: 'no-tests' },
    });
    expect(status(none).reason).toContain('no test file changed');
  });

  it('AC2, AC4: completing build exits 1 on not-red; reclassifying the ticket lifts the gate', () => {
    baseline();
    const c = job();
    commitFile(c.wt, 'src/lib.js', FIXED);
    commitFile(c.wt, 'tests/ok.test.js', OK_TEST);
    expect(verify(store, c).regression?.status).toBe('not-red');
    expect(status(c).reason).toContain('test passed at the base (not red)');
    add(store, c, 'build.md');
    const refused = orch(store.home, tmpdir(), [
      'job',
      'transition',
      c.id,
      'complete',
      '--token',
      c.token,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('test passed at the base (not red)');
    const edit = orch(store.home, tmpdir(), [
      'ticket',
      'edit',
      String(c.ticket),
      '--type',
      'chore',
    ]);
    expect(edit.code, edit.err).toBe(0);
    expect(status(c)).toMatchObject({ valid: true, reason: null });
  });

  it('AC3: no record for HEAD, or a null merge base, is "no regression run for this head"', () => {
    baseline();
    const c = job();
    commitFile(c.wt, 'src/lib.js', FIXED);
    commitFile(c.wt, 'tests/lib.test.js', ADD_TEST);
    verify(store, c);
    const j = getJob(store.db, c.id);
    const wt = worktreeOf(j);
    if (!wt) throw new Error('no worktree');
    const eff = effectivePolicy(j, wt);
    // A policy run valid for HEAD, but no record under this merge base.
    const s = verificationStatus(store, j, wt, { ...eff, mergeBase: null });
    expect(s.valid).toBe(false);
    expect(s.reason).toContain('no regression run for this head');
    // An authorized policy with an unresolvable base ref: the merge base is null, never skipped.
    store.db
      .update(jobs)
      .set({ policy: eff.policy, policyHead: eff.head })
      .where(eq(jobs.id, c.id))
      .run();
    const authorized = getJob(store.db, c.id);
    const noBase = { ...wt, baseRef: 'refs/heads/no-such-branch' };
    const e2 = effectivePolicy(authorized, noBase);
    expect(e2.mergeBase).toBeNull();
    const s2 = verificationStatus(store, authorized, noBase, e2);
    expect(s2.valid).toBe(false);
    expect(s2.reason).toContain('no regression run for this head');
  });

  it('AC5: feature jobs, ticketless jobs, and policies without regression are unaffected', () => {
    baseline();
    for (const type of ['feature', null] as const) {
      const c = job(type);
      commitFile(c.wt, 'src/lib.js', FIXED);
      expect(verify(store, c)).toMatchObject({ status: 'passed', regression: null });
      expect(status(c).valid).toBe(true);
    }
    baseline(false);
    const bug = job();
    commitFile(bug.wt, 'src/lib.js', FIXED);
    expect(verify(store, bug)).toMatchObject({ status: 'passed', regression: null });
    expect(status(bug).valid).toBe(true);
  });

  it('AC6: a Markdown-only bug job (exempt) is valid', () => {
    baseline();
    const c = job();
    commitFile(c.wt, 'docs/fix.md', '# note\n');
    expect(verify(store, c)).toMatchObject({ status: 'passed', regression: { status: 'exempt' } });
    expect(status(c).valid).toBe(true);
  });
});
