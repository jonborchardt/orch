/**
 * Workflow contracts as the /factory skill exercises them: fixture "subagent outputs" are written
 * to the artifact directory and the deterministic CLI decides everything else.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError, WorkflowError } from '../src/core/errors.ts';
import { ROLES } from '../src/core/roles.ts';
import { addArtifact, recordVerdict, transitionGuarded } from '../src/ops/gates.ts';
import { verifyJob } from '../src/ops/verify.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import {
  checkReadonly,
  loadConfig,
  type Plan,
  planJob,
  resumeFactoryJob,
  startJob,
} from '../src/ops/factory.ts';
import { showWorktree } from '../src/ops/worktree.ts';
import { claimJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import {
  commitFile,
  fixture,
  type GhShim,
  ghShim,
  gitIn,
  json,
  makeRepoWithOrigin,
  orch,
  tempDir,
  type TempStore,
  tempStore,
  writeArtifact,
} from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
let shim: GhShim;
const extra: string[] = [];

beforeAll(() => {
  shim = ghShim('acme/alpha');
  Object.assign(process.env, shim.env);
});
afterAll(() => {
  delete process.env['ORCH_GH_SHIM'];
  delete process.env['ORCH_GH_SHIM_STATE'];
  shim.cleanup();
});
beforeEach(() => {
  shim.reset();
  store = tempStore();
  ({ clone, bare } = makeRepoWithOrigin('git@github.com:acme/alpha.git'));
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare, ...extra.splice(0)]) rmSync(d, { recursive: true, force: true });
});

const SESSION = 'claude-20261113-0900-ab12';

interface Ctx {
  id: string;
  token: string;
  dir: string;
  wt: string;
  plan: Plan;
}

/** `orch factory start` as the skill runs it. */
function start(title = 'Add CSV export', repoPath = clone, maxRounds?: number): Ctx {
  const r = startJob(store, { title, session: SESSION, cwd: repoPath, maxRounds });
  return {
    id: r.job.id,
    token: r.token,
    dir: r.plan.artifactDir,
    wt: r.job.worktreePath ?? '',
    plan: r.plan,
  };
}

const next = (id: string, ui?: boolean) => planJob(store, id, { ui });
const go = (c: Ctx, action: Parameters<typeof transitionJob>[2], reason?: string) =>
  transitionGuarded(store, c.id, action, { token: c.token, reason });

/** Fixture subagent: writes a valid artifact, registers it, completes the stage. */
function runStage(c: Ctx, artifact: string, body = fixture(artifact), replace = false) {
  if (getJob(store.db, c.id).status === 'pending') go(c, 'start');
  // The builder and approver verify the commit they describe before registering their artifact.
  if (artifact === 'build.md' || artifact === 'decision.md') {
    verifyJob(store, c.id, { token: c.token });
  }
  writeArtifact(c.dir, artifact, body);
  addArtifact(store, c.id, artifact, { token: c.token, replace });
  return go(c, 'complete');
}

/** Fixture review round: every listed reviewer gets the verdict given; consolidation follows. */
function reviewRound(c: Ctx, verdicts: Record<string, 'PASS' | 'CHANGES'>, blocking = 0) {
  const plan = next(c.id);
  expect(plan.stage).toBe('review');
  if (plan.status === 'pending') go(c, 'start');
  const round = plan.round;
  for (const r of plan.agents) recordVerdict(store, c.id, { token: c.token, reviewer: r.role });
  const fp = next(c.id).worktree?.fingerprint ?? '';
  for (const r of plan.agents) {
    const v = verdicts[r.role] ?? 'PASS';
    writeArtifact(c.dir, r.artifact, fixture(r.artifact, v));
    recordVerdict(store, c.id, {
      token: c.token,
      reviewer: r.role,
      verdict: v === 'PASS' ? 'pass' : 'changes',
      summary: `${r.role} says ${v}`,
    });
  }
  checkReadonly(store, c.id, fp);
  const consolidated = `round-${String(round)}/consolidated.md`;
  writeArtifact(c.dir, consolidated, fixture(consolidated, String(blocking)));
  addArtifact(store, c.id, consolidated, { token: c.token });
  return go(c, 'complete');
}

describe('factory start and spec stage', () => {
  it('creates, claims, and gives a worktree to the job; the first plan is the spec stage', () => {
    const c = start();
    expect(c.plan.step).toBe('run-stage');
    expect(c.plan.stage).toBe('spec');
    expect(c.plan.agents).toEqual([
      { role: 'spec-writer', agent: 'factory-spec-writer', model: 'opus', artifact: 'spec.md' },
    ]);
    expect(c.plan.owner.session).toBe(SESSION);
    expect(c.plan.worktree?.branch).toBe(`factory/${c.id}-add-csv-export`);
    expect(c.plan.repo.identity).toBe('github.com/acme/alpha');
    expect(c.plan.commands).toEqual([
      `orch job transition ${c.id} start --token <token>`,
      `orch job artifact add ${c.id} spec.md --token <token>`,
      `orch job transition ${c.id} complete --token <token>`,
    ]);
    expect(c.plan.requiredArtifacts).toEqual(['spec.md']);
    expect(existsSync(c.wt)).toBe(true);
    // Running `start` again for the same request makes a second, independent job.
    const d = start();
    expect(d.id).not.toBe(c.id);
    expect(d.wt).not.toBe(c.wt);
  });

  it('refuses malformed spec-writer output; the stage can be failed and resumed', () => {
    const c = start();
    go(c, 'start');
    writeArtifact(c.dir, 'spec.md', '# Spec\n\n## Goal\nvague\n');
    expect(() => addArtifact(store, c.id, 'spec.md', { token: c.token })).toThrow(
      /missing required section/,
    );
    expect(() => go(c, 'complete')).toThrow(/missing required artifact spec.md/);
    expect(next(c.id).status).toBe('running');
    go(c, 'fail', 'spec-writer produced no scope');
    const failed = next(c.id);
    expect(failed.step).toBe('resume');
    expect(failed.reason).toContain('failed');
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    expect(r.tookOver).toBe(false);
    expect(r.plan.status).toBe('pending');
    expect(r.plan.step).toBe('run-stage');
    expect(r.token).not.toBe(c.token); // every claim rotates; the old handle is dead
    expect(() => go(c, 'start')).toThrow(OwnershipError);
  });

  it('spec -> build transition hands the builder the spec and no --replace on round 1', () => {
    const c = start();
    expect(runStage(c, 'spec.md').stage).toBe('build');
    const plan = next(c.id);
    expect(plan.agents[0]?.agent).toBe('factory-builder');
    expect(plan.commands).toContain(`orch job artifact add ${c.id} build.md --token <token>`);
    expect(plan.reason).toContain('Implement spec.md');
    expect(plan.artifacts).toEqual([{ path: 'spec.md', stage: 'spec', ok: true }]);
  });
});

describe('review rounds', () => {
  function toReview(c: Ctx, files: string[] = ['src/export.ts']) {
    runStage(c, 'spec.md');
    for (const f of files) commitFile(c.wt, f, `// ${f}`);
    runStage(c, 'build.md');
  }

  it('plans only the always-on reviewers for non-UI changes, all seven for UI changes', () => {
    const c = start();
    toReview(c);
    const plan = next(c.id);
    expect(plan.stage).toBe('review');
    expect(plan.round).toBe(1);
    expect(plan.ui).toBe(false);
    expect(plan.agents.map((a) => a.role)).toEqual(['security', 'correctness', 'code-quality']);
    expect(plan.agents.map((a) => a.model)).toEqual(['opus', 'sonnet', 'sonnet']);
    expect(plan.agents[0]?.artifact).toBe('round-1/review-security.md');
    expect(next(c.id, true).agents).toHaveLength(7);

    const u = start('Restyle header');
    toReview(u, ['src/Header.tsx', 'src/header.css']);
    const up = next(u.id);
    expect(up.ui).toBe(true);
    expect(up.agents.map((a) => a.role)).toEqual([
      'security',
      'correctness',
      'code-quality',
      'ui-design',
      'ux',
      'accessibility',
      'web-platform',
    ]);
    expect(next(u.id, false).agents).toHaveLength(3);
  });

  it('aggregates parallel verdicts: any CHANGES returns to build with the consolidated findings', () => {
    const c = start();
    toReview(c);
    const plan = next(c.id);
    expect(plan.commands.filter((x) => x.includes('review record'))).toHaveLength(6);
    expect(plan.commands.some((x) => x.includes('check-readonly'))).toBe(true);
    const back = reviewRound(c, { correctness: 'CHANGES' }, 1);
    expect([back.stage, back.status, back.round]).toEqual(['build', 'pending', 1]);
    const rework = next(c.id);
    expect(rework.reason).toContain('Rework round 2');
    expect(rework.reason).toContain('round-1/consolidated.md');
    expect(rework.commands).toContain(
      `orch job artifact add ${c.id} build.md --replace --token <token>`,
    );
    // Review history is preserved: round 1 files stay registered and verified.
    expect(rework.artifacts.map((a) => a.path).sort()).toEqual([
      'build.md',
      'round-1/consolidated.md',
      'round-1/review-code-quality.md',
      'round-1/review-correctness.md',
      'round-1/review-security.md',
      'spec.md',
    ]);
  });

  it('a verdict that disagrees with the file, or a missing VERDICT line, is refused', () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    recordVerdict(store, c.id, { token: c.token, reviewer: 'security' });
    writeArtifact(c.dir, 'round-1/review-security.md', '# R\n\n## Findings\nnone\n');
    expect(() =>
      recordVerdict(store, c.id, { token: c.token, reviewer: 'security', verdict: 'pass' }),
    ).toThrow(/VERDICT/);
    writeArtifact(
      c.dir,
      'round-1/review-security.md',
      fixture('round-1/review-security.md', 'CHANGES'),
    );
    expect(() =>
      recordVerdict(store, c.id, { token: c.token, reviewer: 'security', verdict: 'pass' }),
    ).toThrow(/does not match/);
    // Still pending, so the round cannot complete.
    writeArtifact(c.dir, 'round-1/consolidated.md');
    addArtifact(store, c.id, 'round-1/consolidated.md', { token: c.token });
    expect(() => go(c, 'complete')).toThrow(/pending: security/);
    expect(next(c.id).reviews).toEqual([{ reviewer: 'security', verdict: null }]);
  });

  it('check-readonly catches a reviewer that changed the worktree', () => {
    const c = start();
    toReview(c);
    const fp = next(c.id).worktree?.fingerprint ?? '';
    expect(checkReadonly(store, c.id, fp).ok).toBe(true);
    writeFileSync(join(c.wt, 'sneaky.ts'), 'x');
    expect(() => checkReadonly(store, c.id, fp)).toThrow(/Reviewers must not modify code/);
    rmSync(join(c.wt, 'sneaky.ts'));
    expect(checkReadonly(store, c.id, fp).ok).toBe(true);
    commitFile(c.wt, 'also.ts', 'y');
    expect(() => checkReadonly(store, c.id, fp)).toThrow(ValidationError);
  });

  it('rework rounds: rebuild with --replace, re-review, pass -> approve', () => {
    const c = start();
    toReview(c);
    reviewRound(c, { 'code-quality': 'CHANGES' }, 1);
    expect(() => runStage(c, 'build.md', fixture('build.md') + '\nround 2\n')).toThrow(/--replace/);
    // The failed registration left the stage running; register properly and complete.
    addArtifact(store, c.id, 'build.md', { token: c.token, replace: true });
    expect(go(c, 'complete').round).toBe(2);
    expect(next(c.id).agents[0]?.artifact).toBe('round-2/review-security.md');
    const approved = reviewRound(c, {});
    expect([approved.stage, approved.status]).toEqual(['approve', 'pending']);
    const plan = next(c.id);
    expect(plan.agents[0]?.agent).toBe('factory-approver');
    expect(plan.commands.some((x) => x.includes('escalate'))).toBe(true);
  });

  it('escalates to needs-human when the last allowed round still requests changes', () => {
    const c = start('Tight budget', clone, 1);
    toReview(c);
    const blocked = reviewRound(c, { security: 'CHANGES' }, 2);
    expect([blocked.stage, blocked.status]).toEqual(['needs-human', 'blocked']);
    const plan = next(c.id);
    expect(plan.step).toBe('needs-human');
    expect(plan.blockedReason).toBe('max review rounds reached');
    expect(plan.reason).toContain(`orch factory resume ${c.id}`);
    expect(plan.reason).toContain('--to build');
    // A human lets it continue: resume back to build with the same session.
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    expect([r.plan.stage, r.plan.status, r.plan.step]).toEqual(['build', 'pending', 'run-stage']);
  });
});

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

  it('delivers a draft PR through the mocked GitHub CLI and reports done', () => {
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
      `orch gh pr status ${c.id}`,
    ]);
    go(c, 'start');
    pushBranch(store, c.id, { token: c.token });
    writeArtifact(c.dir, 'pr.md');
    const pr = ensureDraftPr(store, c.id, { token: c.token, bodyFile: join(c.dir, 'pr.md') });
    expect(pr.created).toBe(true);
    expect(pr.pr.isDraft).toBe(true);
    expect(pr.pr.headRefName).toBe(`factory/${c.id}-add-csv-export`);
    addArtifact(store, c.id, 'pr.md', { token: c.token });
    const done = go(c, 'complete');
    expect(done.stage).toBe('completed');
    const final = next(c.id);
    expect(final.step).toBe('done');
    expect(final.pr).toEqual({
      url: 'https://github.com/acme/alpha/pull/1',
      state: 'draft',
      ciStatus: 'none',
    });
    expect(final.reason).toContain('Humans mark it ready');
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
    expect(r.plan.artifacts).toEqual([{ path: 'spec.md', stage: 'spec', ok: true }]);
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

describe('orch factory CLI', () => {
  it('start / next / status / resume / config / check-readonly with --json; usage errors exit 2', () => {
    const home = tempDir('orch-factory-cli-');
    extra.push(home);
    const env = { ...shim.env, ORCH_SESSION: 'cli-session' };
    expect(orch(home, clone, ['factory']).code).toBe(2);
    expect(orch(home, clone, ['factory', 'start']).code).toBe(2); // no --session
    expect(orch(home, clone, ['factory', 'start', '--session', 'bad session!']).code).toBe(2);
    const noTitle = orch(home, clone, ['factory', 'start', '--session', 's']);
    expect(noTitle.code).toBe(1);
    expect(noTitle.err).toContain('Provide --title');
    expect(orch(home, tmpdir(), ['factory', 'start', '--title', 'x', '--session', 's']).code).toBe(
      1,
    );

    // From an issue: the title is fetched through gh (the shim here).
    const started = json<{
      token: string;
      job: { id: string; title: string; description: string };
      plan: Plan;
    }>(orch(home, clone, ['--json', 'factory', 'start', '--issue', '#12'], env));
    expect(started.job.title).toBe('Export CSV');
    expect(started.job.description).toContain('issues/12');
    expect(started.plan.step).toBe('run-stage');
    const id = started.job.id;
    const token = started.token;

    const status = json<Plan>(orch(home, tmpdir(), ['--json', 'factory', 'status', id]));
    expect(status.stage).toBe('spec');
    expect(orch(home, tmpdir(), ['factory', 'next']).code).toBe(2);
    expect(orch(home, tmpdir(), ['factory', 'next', 'job-nope']).code).toBe(3);
    const human = orch(home, tmpdir(), ['factory', 'next', id]);
    expect(human.out).toContain('factory-spec-writer');

    // Follow the plan's commands literally, substituting the token.
    for (const cmd of status.commands.slice(0, 1)) {
      const argv = cmd.replace('<token>', token).split(' ').slice(1);
      expect(orch(home, tmpdir(), argv).code).toBe(0);
    }
    const dir = status.artifactDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), fixture('spec.md'));
    for (const cmd of status.commands.slice(1)) {
      const argv = cmd.replace('<token>', token).split(' ').slice(1);
      expect(orch(home, tmpdir(), argv).code).toBe(0);
    }
    expect(json<Plan>(orch(home, tmpdir(), ['--json', 'factory', 'next', id])).stage).toBe('build');

    const fp = status.worktree?.fingerprint ?? '';
    const readonly = orch(home, tmpdir(), ['factory', 'check-readonly', id, '--fingerprint', fp]);
    expect(readonly.code, readonly.err).toBe(0);
    expect(orch(home, tmpdir(), ['factory', 'check-readonly', id]).code).toBe(2);
    expect(orch(home, tmpdir(), ['factory', 'check-readonly', id, '--fingerprint', 'x']).code).toBe(
      1,
    );

    const cfg = json<{ file: string; maxRounds: number }>(
      orch(home, tmpdir(), ['--json', 'factory', 'config']),
    );
    expect(cfg.file).toBe(join(home, 'factory.json'));
    expect(cfg.maxRounds).toBe(3);

    expect(orch(home, tmpdir(), ['factory', 'resume', id]).code).toBe(2);
    expect(
      orch(home, tmpdir(), ['factory', 'resume', id, '--session', 'x', '--to', 'nope']).code,
    ).toBe(2);
    const resumed = json<{ tookOver: boolean; token: string; plan: Plan }>(
      orch(home, tmpdir(), ['--json', 'factory', 'resume', id, '--session', 'cli-session']),
    );
    expect(resumed.tookOver).toBe(false);
    expect(resumed.token).not.toBe(token); // every claim rotates the token
    const contested = orch(home, tmpdir(), ['factory', 'resume', id, '--session', 'other']);
    expect(contested.code).toBe(4);
    expect(readFileSync(join(dir, 'spec.md'), 'utf8')).toContain('Acceptance criteria');
  });
});
