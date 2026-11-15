/**
 * Delivery binds the approval: pr and ci completion refuse a HEAD the approver never saw, and a PR
 * that is not the job's own is escalated, whatever plain Git or a manual PR did.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.ts';
import { pushBranch } from '../src/ops/github.ts';
import { findArtifact } from '../src/storage/artifacts.ts';
import { recordPr, resumeJob } from '../src/storage/jobs.ts';
import {
  add,
  type Ctx,
  deliverPr,
  go,
  head,
  prBody,
  start,
  toCi,
  toPr,
  toReview,
  verify,
} from './drive.ts';
import { commitFile, gitIn, orch } from './helpers.ts';
import { store, clone, shim, run, checks, reconcile, job } from './ci-fixture.ts';

describe('delivery binds the approval: pr and ci completion, not only push', () => {
  /** A PR opened outside orch (`gh pr create` by hand), recorded on the job as `orch job pr` did. */
  function manualPr(c: Ctx, base = 'main', headRef = job(c).branch ?? ''): string {
    const s = shim.read();
    const n = s.prs.length + 1;
    const url = `https://github.com/acme/alpha/pull/${String(n)}`;
    s.prs.push({
      number: n,
      url,
      state: 'OPEN',
      isDraft: true,
      baseRefName: base,
      headRefName: headRef,
      title: 'manual',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [],
      body: 'manual',
    });
    shim.write({ prs: s.prs });
    recordPr(store, c.id, { token: c.token, url, state: 'draft' });
    return url;
  }

  /** Verify the current HEAD, push it with plain git, and open a PR by hand: everything but orch gh. */
  function deliverByHand(c: Ctx): void {
    verify(store, c);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(ValidationError);
    gitIn(c.wt, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/${job(c).branch ?? ''}`);
    manualPr(c);
    add(store, c, 'pr.md', prBody(store, c), true);
  }

  it('an ordinary commit after approval cannot complete pr', () => {
    const c = start(store, clone);
    toPr(store, c);
    commitFile(c.wt, 'src/unreviewed.ts', '// never reviewed\n', 'unreviewed');
    deliverByHand(c);
    expect(() => go(store, c, 'complete')).toThrow(/not approved/);
    expect(job(c).stage).toBe('pr');
  });

  it('a HEAD rewound behind the approval cannot complete pr', () => {
    const c = start(store, clone);
    toPr(store, c);
    gitIn(c.wt, 'reset', '-q', '--hard', 'HEAD~1');
    deliverByHand(c);
    expect(() => go(store, c, 'complete')).toThrow(/does not contain the approved commit/);
  });

  it('a HEAD diverged from the approval cannot complete pr', () => {
    const c = start(store, clone);
    toPr(store, c);
    gitIn(c.wt, 'reset', '-q', '--hard', 'HEAD~1');
    commitFile(c.wt, 'src/other.ts', '// different work\n', 'diverge');
    deliverByHand(c);
    expect(() => go(store, c, 'complete')).toThrow(/does not contain the approved commit/);
  });

  it('a base merge with edits inside the merge commit cannot complete pr', () => {
    const c = start(store, clone);
    toPr(store, c);
    commitFile(clone, 'src/base.ts', '// base\n', 'base moves');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    gitIn(c.wt, 'fetch', '-q', 'origin', 'main');
    gitIn(
      c.wt,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'merge',
      '--no-commit',
      '--no-ff',
      'origin/main',
    );
    commitFile(c.wt, 'src/sneaky.ts', '// inside the merge\n', 'merge with edits');
    deliverByHand(c);
    expect(() => go(store, c, 'complete')).toThrow(/match neither parent/);
  });

  it('a commit pushed by plain git during ci cannot complete the job, even with passing checks', () => {
    const c = start(store, clone);
    toCi(store, c);
    commitFile(c.wt, 'src/after-pr.ts', '// pushed during CI\n', 'during ci');
    verify(store, c);
    gitIn(c.wt, 'push', '-q', 'origin', `HEAD:refs/heads/${job(c).branch ?? ''}`);
    checks(head(c.wt), [run('test', 'success')]);
    expect(() => reconcile(c)).toThrow(/not approved/);
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running' });
  });

  it('a job resumed past approve without ever being approved cannot complete', () => {
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'escalate', 'stuck');
    const c2 = {
      ...c,
      token: resumeJob(store, c.id, { session: 'human', to: 'pr', force: true }).token,
    };
    go(store, c2, 'start');
    verify(store, c2);
    gitIn(c.wt, 'push', '-q', 'origin', `HEAD:refs/heads/${job(c).branch ?? ''}`);
    manualPr(c2);
    add(store, c2, 'pr.md', prBody(store, c2), true);
    expect(() => go(store, c2, 'complete')).toThrow(/No DECISION: APPROVE recorded/);
    go(store, c2, 'escalate', 'skip pr');
    const c3 = {
      ...c,
      token: resumeJob(store, c.id, { session: 'human2', to: 'ci', force: true }).token,
    };
    go(store, c3, 'start');
    checks(head(c.wt), [run('test', 'success')]);
    expect(() => reconcile(c3)).toThrow(/No DECISION: APPROVE recorded/);
    expect(findArtifact(store.db, c.id, 'decision.md')).toBeUndefined();
    expect(job(c).stage).toBe('ci');
  });

  it('a PR into another base branch, or from another head branch, is escalated, never completed', () => {
    for (const [base, branchName] of [
      ['scratch', null],
      ['main', 'elsewhere'],
    ] as const) {
      const c = start(store, clone, `PR identity ${base}`);
      toPr(store, c);
      pushBranch(store, c.id, { token: c.token });
      const headRef = branchName ?? job(c).branch ?? '';
      gitIn(clone, 'push', '-q', 'origin', `main:refs/heads/scratch`);
      gitIn(c.wt, 'push', '-q', 'origin', `HEAD:refs/heads/${headRef}`);
      manualPr(c, base, headRef);
      add(store, c, 'pr.md', prBody(store, c), true);
      go(store, c, 'complete');
      go(store, c, 'start');
      checks(head(c.wt), [run('test', 'success')]);
      const r = reconcile(c);
      expect(r).toMatchObject({ outcome: 'outdated', action: 'escalate', current: false });
      expect(r.reason).toContain("not the job's");
      expect(job(c).stage).toBe('needs-human');
    }
  });

  it('a clean base merge after the approval still delivers and completes', () => {
    const c = start(store, clone);
    toPr(store, c);
    commitFile(clone, 'src/base.ts', '// base\n', 'base moves');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    gitIn(c.wt, 'fetch', '-q', 'origin', 'main');
    gitIn(
      c.wt,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'merge',
      '-q',
      '--no-edit',
      'origin/main',
    );
    verify(store, c);
    deliverPr(store, c);
    go(store, c, 'start');
    checks(head(c.wt), [run('test', 'success')]);
    expect(reconcile(c)).toMatchObject({ action: 'complete' });
    expect(job(c).stage).toBe('completed');
    expect(job(c).ciHead).not.toBe(findArtifact(store.db, c.id, 'decision.md')?.head);
  });

  it('orch job pr no longer exists: PRs are recorded by orch gh pr create', () => {
    const c = start(store, clone);
    const r = orch(store.home, clone, [
      'job',
      'pr',
      c.id,
      '--url',
      'https://x/1',
      '--state',
      'draft',
    ]);
    expect(r.code).toBe(2);
  });
});
