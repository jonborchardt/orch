/**
 * Adversarial cases for approval, blocking findings, and what gets pushed (invariants 10, 11, 15).
 */
import * as drive from './drive.ts';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/core/errors.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { verifyJob } from '../src/ops/verify.ts';
import { adoptWorktree, dropWorktree, integrateBase } from '../src/ops/worktree.ts';
import { getJob } from '../src/storage/jobs.ts';
import { head, SESSION } from './drive.ts';
import { commitFile, fixture, gitIn, tempDir, writeArtifact } from './helpers.ts';
import {
  store,
  clone,
  bare,
  shim,
  extra,
  start,
  go,
  add,
  verdict,
  toReview,
  passRound,
  toPr,
} from './audit-fixture.ts';

describe('invariants 10, 11, and 15: approval, blocking findings, and what gets pushed', () => {
  it('all PASS verdicts with a non-zero BLOCKING count still send the job back to build', () => {
    const c = start();
    toReview(c);
    passRound(c, '2');
    const job = getJob(store.db, c.id);
    expect([job.stage, job.status, job.round]).toEqual(['build', 'pending', 1]);
  });

  it('a human jump to approve cannot approve over blocking findings', () => {
    const c = start('Tight budget');
    toReview(c);
    go(c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(c, r, 'CHANGES');
    add(c, 'round-1/consolidated.md', fixture('round-1/consolidated.md', '3'));
    go(c, 'complete'); // back to build
    go(c, 'escalate', 'giving up');
    const r = resumeFactoryJob(store, c.id, { session: SESSION, to: 'approve' });
    const c2 = { ...c, token: r.token };
    go(c2, 'start');
    add(c2, 'decision.md');
    expect(() => go(c2, 'complete')).toThrow(/still counts 3 blocking finding/);
  });

  it('decision.md is tied to a commit: a later commit invalidates the approval', () => {
    const c = start();
    toReview(c);
    passRound(c);
    go(c, 'start');
    writeFileSync(join(c.wt, 'sneak.ts'), 'x');
    expect(() => add(c, 'decision.md')).toThrow(/uncommitted changes/);
    rmSync(join(c.wt, 'sneak.ts'));
    const decision = add(c, 'decision.md');
    expect(decision.head).toBe(head(c.wt));
    commitFile(c.wt, 'sneak.ts', 'x');
    expect(() => go(c, 'complete')).toThrow(/decision.md describe/);
  });

  it('reaching pr by a human decision does not finish without a recorded approval', () => {
    const c = start();
    toReview(c);
    passRound(c);
    go(c, 'escalate', 'skip the approver');
    const r = dashboardAction(store, c.id, { action: 'approve', to: 'pr' });
    expect(r.job.stage).toBe('pr');
    const again = resumeFactoryJob(store, c.id, { session: SESSION });
    const c2 = { ...c, token: again.token };
    go(c2, 'start');
    expect(() => pushBranch(store, c.id, { token: c2.token })).toThrow(/No DECISION: APPROVE/);
    expect(() =>
      ensureDraftPr(store, c.id, { token: c2.token, bodyFile: join(c.dir, 'spec.md') }),
    ).toThrow(/No DECISION: APPROVE/);
    expect(shim.read().calls.some((x) => x[1] === 'create')).toBe(false);
  });

  it('pushing is refused before the pr stage, and never for the base branch', () => {
    const c = start();
    toReview(c);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/pr stage only/);
    expect(gitIn(bare, 'branch', '--list', 'factory/*')).toBe('');
    // A worktree sitting on the base branch is not adoptable, so a job can never push it.
    const d = start('Other job');
    const onMain = tempDir('orch-main-wt-');
    extra.push(onMain);
    rmSync(onMain, { recursive: true, force: true });
    gitIn(clone, 'checkout', '-q', '-b', 'elsewhere');
    gitIn(clone, 'worktree', 'add', '-q', onMain, 'main');
    expect(() => adoptWorktree(store, d.id, { token: d.token }, onMain)).toThrow(
      /on the base branch main/,
    );
    // Nor is a directory inside the initiating checkout.
    const nested = join(clone, 'nested-wt');
    gitIn(clone, 'worktree', 'add', '-q', '-b', 'nested', nested, 'main');
    expect(() => adoptWorktree(store, d.id, { token: d.token }, nested)).toThrow(/inside it/);
  });

  it('base integration after approval is pushable; any other commit is not', () => {
    const c = start();
    toPr(c);
    commitFile(clone, 'upstream.txt', 'u');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    expect(planJob(store, c.id).worktree?.behind).toBe(1);
    const merged = integrateBase(store, c.id, { token: c.token });
    expect(merged.merge.merged).toBe(true);
    // The merge commit is new code as far as evidence goes: verify it before it can leave.
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/No valid verification run/);
    verifyJob(store, c.id, { token: c.token });
    expect(pushBranch(store, c.id, { token: c.token }).pushed).toBe(true);
    commitFile(c.wt, 'extra.ts', 'not reviewed');
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/not approved/);
  });

  it('a HEAD behind the approved commit is not pushable either', () => {
    const c = start();
    toPr(c);
    // Rewinding to the parent leaves approved..HEAD empty, but the approver never saw this state.
    gitIn(c.wt, 'reset', '-q', '--hard', 'HEAD~1');
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(
      /does not contain the approved commit/,
    );
    expect(gitIn(bare, 'branch', '--list', 'factory/*')).toBe('');
  });

  it('pushing is refused once the job left the pr stage', () => {
    const c = start();
    drive.toCi(store, c);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/pr stage only/);
  });

  it('code evidence and its stage cannot be completed without the job worktree', () => {
    const c = start();
    go(c, 'start');
    add(c, 'spec.md');
    go(c, 'complete');
    go(c, 'start');
    commitFile(c.wt, 'src/export.ts', '// export\n');
    add(c, 'build.md');
    dropWorktree(store, c.id, { token: c.token });
    expect(getJob(store.db, c.id).worktreePath).toBeNull();
    expect(() => go(c, 'complete')).toThrow(/needs the job worktree/);
    expect(() => drive.add(store, c, 'build.md', fixture('build.md'), true)).toThrow(
      /needs the job worktree/,
    );
  });

  it('an interrupted PR creation is reused on retry, never duplicated', () => {
    const c = start();
    toPr(c);
    pushBranch(store, c.id, { token: c.token });
    writeArtifact(c.dir, 'pr.md');
    // gh creates the PR, then dies before orch can read it back and record it.
    shim.write({ fail: 'pr view' });
    expect(() =>
      ensureDraftPr(store, c.id, { token: c.token, bodyFile: join(c.dir, 'pr.md') }),
    ).toThrow(ToolError);
    expect(shim.read().prs).toHaveLength(1);
    expect(getJob(store.db, c.id).prUrl).toBeNull();
    shim.write({ fail: undefined });
    const retry = ensureDraftPr(store, c.id, { token: c.token, bodyFile: join(c.dir, 'pr.md') });
    expect(retry.created).toBe(false);
    expect(retry.job.prUrl).toBe('https://github.com/acme/alpha/pull/1');
    expect(shim.read().calls.filter((x) => x[1] === 'create')).toHaveLength(1);
  });
});
