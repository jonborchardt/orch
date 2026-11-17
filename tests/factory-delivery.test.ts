/**
 * Workflow contracts as the /factory skill exercises them: approval, rejection, delivery, resume,
 * ownership, and cross-project jobs.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnershipError, WorkflowError } from '../src/core/errors.ts';
import { ROLES } from '../src/core/roles.ts';
import { addArtifact } from '../src/ops/gates.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { loadConfig, resumeFactoryJob } from '../src/ops/factory.ts';
import { showWorktree } from '../src/ops/worktree.ts';
import { claimJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import {
  commitFile,
  fixture,
  gitIn,
  makeRepoWithOrigin,
  tempDir,
  writeArtifact,
} from './helpers.ts';
import {
  store,
  clone,
  shim,
  extra,
  SESSION,
  type Ctx,
  start,
  next,
  go,
  runStage,
  reviewRound,
} from './factory-fixture.ts';

describe('approval, rejection, delivery', () => {
  function toApprove(c: Ctx) {
    runStage(c, 'spec.md');
    commitFile(c.wt, 'src/export.ts', 'export const csv = 1;');
    runStage(c, 'build.md');
    reviewRound(c, {});
    expect(next(c.id).stage).toBe('approve');
  }

  it('ESCALATE cannot be completed around; escalate, human resumes, APPROVE moves to pr', () => {
    const c = start();
    toApprove(c);
    go(c, 'start');
    writeArtifact(c.dir, 'decision.md', fixture('decision.md', 'ESCALATE'));
    addArtifact(store, c.id, 'decision.md', { token: c.token });
    expect(() => go(c, 'complete')).toThrow(/says ESCALATE; use escalate/);
    go(c, 'escalate', 'AC2 has no evidence');
    expect(next(c.id).step).toBe('needs-human');
    expect(next(c.id).blockedReason).toBe('AC2 has no evidence');

    // The original session still holds a live lease, so a hand-off to a new session is explicit.
    expect(() => resumeFactoryJob(store, c.id, { session: 'claude-later-ff00' })).toThrow(
      OwnershipError,
    );
    const r = resumeFactoryJob(store, c.id, { session: 'claude-later-ff00', force: true });
    expect(r.tookOver).toBe(true);
    expect(r.previousOwner).toBe(SESSION);
    expect([r.plan.stage, r.plan.status]).toEqual(['approve', 'pending']);
    const c2 = { ...c, token: r.token };
    expect(() => runStage(c2, 'decision.md')).toThrow(/--replace/);
    addArtifact(store, c.id, 'decision.md', { token: r.token, replace: true });
    expect(go(c2, 'complete').stage).toBe('pr');
  });

  it('delivers a draft PR through the mocked GitHub CLI and hands the job to the ci stage', () => {
    const c = start();
    toApprove(c);
    runStage(c, 'decision.md');
    const plan = next(c.id);
    expect(plan.stage).toBe('pr');
    expect(plan.commands).toEqual([
      `orch job transition ${c.id} start --token <token>`,
      `orch gh push ${c.id} --token <token>`,
      `orch gh pr create ${c.id} --body-file "${join(c.dir, 'pr.md')}" --token <token>`,
      `orch job artifact add ${c.id} pr.md --token <token>`,
      `orch job transition ${c.id} complete --token <token>`,
      `orch factory next ${c.id}`,
    ]);
    go(c, 'start');
    pushBranch(store, c.id, { token: c.token });
    writeArtifact(c.dir, 'pr.md');
    const pr = ensureDraftPr(store, c.id, { token: c.token, bodyFile: join(c.dir, 'pr.md') });
    expect(pr.created).toBe(true);
    expect(pr.pr.isDraft).toBe(true);
    expect(pr.pr.headRefName).toBe(`factory/${c.id}-add-csv-export`);
    addArtifact(store, c.id, 'pr.md', { token: c.token });
    const handed = go(c, 'complete');
    expect([handed.stage, handed.status]).toEqual(['ci', 'pending']);
    const ci = next(c.id);
    expect(ci.step).toBe('run-stage');
    expect(ci.commands).toEqual([
      `orch job transition ${c.id} start --token <token>`,
      `orch gh ci ${c.id} --token <token>`,
      `orch factory next ${c.id}`,
    ]);
    expect(ci.pr).toEqual({
      url: 'https://github.com/acme/alpha/pull/1',
      state: 'draft',
      ciStatus: 'none',
    });
    expect(ci.ci).toMatchObject({ head: null, current: false, repairs: 0, maxRepairs: 2 });
    // Completing ci by hand is refused outright (only orch gh ci completes it, after a fresh
    // read), and the pure rules would refuse the headless `none` rollup anyway.
    go(c, 'start');
    expect(() => go(c, 'complete')).toThrow(/completed by orch gh ci/);
    expect(() => transitionJob(store, c.id, 'complete', { token: c.token })).toThrow(
      /no CI verdict has been read/,
    );
    // The shim saw exactly one create, with a draft flag and the pr.md body.
    const creates = shim.read().calls.filter((x) => x[1] === 'create');
    expect(creates).toHaveLength(1);
    expect((shim.read().prs[0] as { body: string }).body).toContain('Known limitations');
  });

  it('plans base integration when the base branch advanced during the job', () => {
    const c = start();
    toApprove(c);
    runStage(c, 'decision.md');
    commitFile(clone, 'other.txt', 'o');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const plan = next(c.id);
    expect(plan.worktree?.behind).toBe(1);
    expect(plan.reason).toContain('1 commit(s) ahead');
    expect(plan.commands[1]).toContain(`orch worktree integrate ${c.id}`);
  });

  it('cancel ends the job from any stage', () => {
    const c = start();
    runStage(c, 'spec.md');
    go(c, 'cancel', 'not needed');
    expect(next(c.id).step).toBe('cancelled');
    // Cancelling released the job; even a new owner cannot restart it.
    expect(() => go(c, 'start')).toThrow(OwnershipError);
    c.token = claimJob(store, c.id, { session: SESSION }).token;
    expect(() => go(c, 'start')).toThrow(WorkflowError);
  });
});

describe('resume, ownership, and cross-project', () => {
  it('a new session adopts an interrupted job from persisted state with its worktree and artifacts', () => {
    const c = start();
    runStage(c, 'spec.md');
    // Simulate the owning session dying mid-build with a lapsed lease.
    c.token = claimJob(store, c.id, { session: SESSION, leaseMinutes: 0 }).token;
    go(c, 'start');
    commitFile(c.wt, 'src/half.ts', 'half done');
    const orphan = next(c.id);
    expect(orphan.step).toBe('resume');
    expect(orphan.owner.expired).toBe(true);
    expect(orphan.reason).toContain('lapsed');

    const r = resumeFactoryJob(store, c.id, { session: 'claude-second-0001' });
    expect(r.tookOver).toBe(true);
    expect(r.previousOwner).toBe(SESSION);
    expect(r.job.ownerSession).toBe('claude-second-0001');
    expect([r.plan.stage, r.plan.status, r.plan.step]).toEqual(['build', 'pending', 'run-stage']);
    expect(r.plan.worktree?.path).toBe(c.wt);
    expect(r.plan.worktree?.commits.map((x) => x.subject)).toEqual(['add src/half.ts']);
    expect(r.plan.artifacts).toEqual([
      { path: 'spec.md', stage: 'spec', ok: true },
      { path: 'spec-review-1.md', stage: 'spec', ok: true },
    ]);
    expect(r.plan.reason).toContain('Implement spec.md');
    // The old session's token is dead; the new one continues.
    expect(() => go(c, 'start')).toThrow(OwnershipError);
    const c2 = { ...c, token: r.token };
    expect(runStage(c2, 'build.md').stage).toBe('review');
    // Resuming again from the same session name issues a new token and kills the previous one.
    const again = resumeFactoryJob(store, c.id, { session: 'claude-second-0001' });
    expect(again.token).not.toBe(r.token);
    expect(again.tookOver).toBe(false);
    expect(again.plan.stage).toBe('review');
    expect(() => go(c2, 'start')).toThrow(OwnershipError);
  });

  it('resume rebuilds a missing worktree and flags tampered artifacts', () => {
    const c = start();
    runStage(c, 'spec.md');
    rmSync(c.wt, { recursive: true, force: true });
    writeFileSync(join(c.dir, 'spec.md'), fixture('spec.md') + '\nedited behind orch\n');
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    expect(existsSync(c.wt)).toBe(true);
    expect(r.plan.artifacts).toEqual([
      { path: 'spec.md', stage: 'spec', ok: false, problem: 'content changed since registration' },
      { path: 'spec-review-1.md', stage: 'spec', ok: true },
    ]);
    rmSync(join(c.dir, 'spec.md'));
    expect(next(c.id).artifacts[0]?.problem).toMatch(/not found/);
  });

  it('a live owner is protected: resume without --force fails, --force rotates the token', () => {
    const c = start();
    expect(() => resumeFactoryJob(store, c.id, { session: 'intruder' })).toThrow(OwnershipError);
    expect(next(c.id).owner.session).toBe(SESSION);
    const forced = resumeFactoryJob(store, c.id, { session: 'intruder', force: true });
    expect(forced.tookOver).toBe(true);
    expect(() => go(c, 'start')).toThrow(/Stale or invalid token/);
    expect(forced.plan.owner.session).toBe('intruder');
  });

  it('ownership lost mid-workflow: the old session cannot register, review, or advance', () => {
    const c = start();
    runStage(c, 'spec.md');
    go(c, 'start');
    const taken = claimJob(store, c.id, { session: 'claude-other', force: true });
    expect(taken.job.status).toBe('interrupted');
    writeArtifact(c.dir, 'build.md');
    expect(() => addArtifact(store, c.id, 'build.md', { token: c.token })).toThrow(OwnershipError);
    expect(() => go(c, 'complete')).toThrow(OwnershipError);
    expect(() => showWorktree(store, c.id)).not.toThrow();
    const plan = next(c.id);
    expect(plan.step).toBe('resume');
    expect(plan.owner.session).toBe('claude-other');
  });

  it('cross-project: jobs from two repositories keep separate worktrees, branches, and plans', () => {
    const other = makeRepoWithOrigin('https://github.com/acme/beta.git', tempDir('orch-beta-'));
    extra.push(other.clone, other.bare);
    const a = start('Alpha work');
    const b = start('Beta work', other.clone);
    expect(a.plan.repo.identity).toBe('github.com/acme/alpha');
    expect(b.plan.repo.identity).toBe('github.com/acme/beta');
    expect(a.wt).toContain('github.com-acme-alpha');
    expect(b.wt).toContain('github.com-acme-beta');
    expect(gitIn(a.wt, 'rev-parse', '--git-common-dir')).not.toBe(
      gitIn(b.wt, 'rev-parse', '--git-common-dir'),
    );
    // Both advance independently in one shared database.
    runStage(a, 'spec.md');
    expect(next(a.id).stage).toBe('build');
    expect(next(b.id).stage).toBe('spec');
  });

  it('role models and UI patterns come from <config>/factory.json; bad files are rejected', () => {
    const file = join(store.paths.config, 'factory.json');
    expect(loadConfig(store).models).toEqual({});
    writeFileSync(
      file,
      JSON.stringify({ models: { security: 'sonnet', approver: 'inherit' }, maxRounds: 2 }),
    );
    const c = start();
    expect(getJob(store.db, c.id).maxRounds).toBe(2);
    runStage(c, 'spec.md');
    commitFile(c.wt, 'a.ts', 'a');
    runStage(c, 'build.md');
    expect(next(c.id).agents.find((x) => x.role === 'security')?.model).toBe('sonnet');
    writeFileSync(file, JSON.stringify({ models: { nobody: 'opus' } }));
    expect(() => next(c.id)).toThrow(/unknown role "nobody"/);
    writeFileSync(file, JSON.stringify({ models: { security: 'gpt' } }));
    expect(() => next(c.id)).toThrow(/must be one of/);
    writeFileSync(file, JSON.stringify({ uiPatterns: ['('] }));
    expect(() => next(c.id)).toThrow(/invalid uiPatterns regex/);
    writeFileSync(file, JSON.stringify({ uiPatterns: ['\\.ts$'] }));
    expect(next(c.id).ui).toBe(true);
    writeFileSync(file, '{ not json');
    expect(() => next(c.id)).toThrow(/not valid JSON/);
    writeFileSync(file, JSON.stringify({ extra: 1 }));
    expect(() => next(c.id)).toThrow(/unknown key/);
    expect(ROLES.filter((r) => r.kind === 'review')).toHaveLength(7);
  });
});
