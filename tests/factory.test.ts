/**
 * Workflow contracts as the /factory skill exercises them: fixture "subagent outputs" are written
 * to the artifact directory and the deterministic CLI decides everything else.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnershipError } from '../src/core/errors.ts';
import { addArtifact, recordVerdict } from '../src/ops/gates.ts';
import { checkReadonly, type Plan, resumeFactoryJob } from '../src/ops/factory.ts';
import { commitFile, fixture, gitIn, json, orch, tempDir, writeArtifact } from './helpers.ts';
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
    expect(() => checkReadonly(store, c.id, fp)).toThrow(/Reviewers must not modify code/);
  });

  it('check-readonly reports a failed inspection with its Git error, not as a reviewer write', () => {
    const c = start();
    const fp = next(c.id).worktree?.fingerprint ?? '';
    // Still a worktree, but HEAD names a branch that does not exist, so it cannot be read.
    const head = join(gitIn(c.wt, 'rev-parse', '--absolute-git-dir'), 'HEAD');
    const saved = readFileSync(head, 'utf8');
    writeFileSync(head, 'ref: refs/heads/no-such-branch\n');
    expect(() => checkReadonly(store, c.id, fp)).toThrow(
      /^Worktree is missing or unreadable at .*: rev-parse HEAD: git rev-parse failed in .*HEAD/s,
    );
    writeFileSync(head, saved);
    expect(checkReadonly(store, c.id, fp).ok).toBe(true);
    // The worktree's .git file points at a gitdir that is gone: no longer a worktree at all.
    // (Removed first: Git marks it hidden, and Windows refuses to overwrite a hidden file.)
    rmSync(join(c.wt, '.git'));
    writeFileSync(join(c.wt, '.git'), `gitdir: ${join(c.wt, 'missing-gitdir')}\n`);
    const r = orch(store.home, tmpdir(), ['factory', 'check-readonly', c.id, '--fingerprint', fp]);
    expect(r.code, r.err).toBe(1);
    expect(r.err).toContain('rev-parse --show-toplevel: git rev-parse failed');
    expect(r.err).toContain('fatal: '); // Git's own message (its wording varies by version)
    expect(r.err).not.toContain('Reviewers must not modify code');
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
    // Without a description (none, or blank) a title alone creates nothing: no job, no worktree.
    for (const blank of [[], ['--description', '']]) {
      const r = orch(home, clone, ['factory', 'start', '--title', 't', '--session', 's', ...blank]);
      expect(r.code, r.err).toBe(2);
      expect(r.err).toContain('--description');
    }
    expect(json(orch(home, tmpdir(), ['--json', 'job', 'list']))).toEqual([]);
    const created = readdirSync(home, { recursive: true }).map(String);
    expect(created.filter((p) => p.split(/[\\/]/).includes('worktrees'))).toEqual([]);
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
