/**
 * Phase 5A adversarial cases: each test is a way the factory could have been driven past one of
 * its guarantees, and the refusal that now stops it. Real temporary repositories throughout: an
 * initiating checkout with a local bare origin, and the job's managed worktree under ORCH_HOME.
 */
import { readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../src/cli/doctor.ts';
import { runInstall } from '../src/cli/install.ts';
import { ToolError, WorkflowError } from '../src/core/errors.ts';
import { installRoot } from '../src/core/paths.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { recordVerdict } from '../src/ops/gates.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { verifyJob } from '../src/ops/verify.ts';
import { adoptWorktree, integrateBase } from '../src/ops/worktree.ts';
import { listArtifacts } from '../src/storage/artifacts.ts';
import {
  getJob,
  listReviews,
  recordReview as storageRecordReview,
  transitionJob,
} from '../src/storage/jobs.ts';
import * as drive from './drive.ts';
import { type Ctx, head, SESSION } from './drive.ts';
import {
  commitFile,
  fixture,
  type GhShim,
  ghShim,
  gitIn,
  makeRepoWithOrigin,
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

// The drivers from tests/drive.ts, bound to this file's store and clone.
const start = (title?: string) => drive.start(store, clone, title);
const go = (c: Ctx, action: Parameters<typeof transitionJob>[2], reason?: string) =>
  drive.go(store, c, action, reason);
const add = (c: Ctx, rel: string, body?: string, replace?: boolean) => {
  // Code evidence is verified first, as the builder and approver do (same refusal on a dirty tree).
  if (rel === 'build.md' || rel === 'decision.md') drive.verify(store, c);
  return drive.add(store, c, rel, body, replace);
};
const verdict = (c: Ctx, reviewer: string, v?: 'PASS' | 'CHANGES') =>
  drive.verdict(store, c, reviewer, v);
const toReview = (c: Ctx) => {
  drive.toReview(store, c);
};
const passRound = (c: Ctx, blocking?: string) => {
  drive.passRound(store, c, blocking);
};
const toPr = (c: Ctx) => {
  drive.toPr(store, c);
};

describe('invariants 3 and 4: one immutable commit per review round', () => {
  it('a verdict cannot be recorded while the worktree has uncommitted changes', () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    writeFileSync(join(c.wt, 'src', 'export.ts'), 'export const csv = 2;');
    expect(() => verdict(c, 'security')).toThrow(/uncommitted changes/);
    expect(listReviews(store.db, c.id)).toEqual([]);
  });

  it('verdicts given against different commits cannot complete the round', () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    const first = verdict(c, 'security');
    expect(first.head).toBe(head(c.wt));
    // The builder keeps going while reviewers are reading.
    commitFile(c.wt, 'src/more.ts', 'x');
    verdict(c, 'correctness');
    verdict(c, 'code-quality');
    add(c, 'round-1/consolidated.md');
    // The Git-aware gate refuses first (HEAD moved past the earliest verdict)...
    expect(() => go(c, 'complete')).toThrow(/round 1 verdicts describe/);
    // ...and the pure rule refuses on its own, so bypassing the gate changes nothing.
    expect(() => transitionJob(store, c.id, 'complete', { token: c.token })).toThrow(
      /different commits/,
    );
    expect(() => transitionJob(store, c.id, 'complete', { token: c.token })).toThrow(WorkflowError);
  });

  it('a commit after all verdicts makes the round stale', () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(c, r);
    add(c, 'round-1/consolidated.md');
    commitFile(c.wt, 'src/late.ts', 'late');
    expect(() => go(c, 'complete')).toThrow(/implementation changed since that evidence/);
    // Dirty, uncommitted edits block the same way.
    gitIn(c.wt, 'reset', '-q', '--hard', 'HEAD~1'); // test only: undo the late commit
    writeFileSync(join(c.wt, 'stray.txt'), 'x');
    expect(() => go(c, 'complete')).toThrow(/uncommitted changes/);
    rmSync(join(c.wt, 'stray.txt'));
    expect(go(c, 'complete').stage).toBe('approve');
  });

  it('a verdict recorded through storage without a commit reference does not count', () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(c, r);
    add(c, 'round-1/consolidated.md');
    // Something bypasses the CLI and re-records a verdict without the head.
    storageRecordReview(store, c.id, { token: c.token, reviewer: 'security', verdict: 'pass' });
    expect(() => go(c, 'complete')).toThrow(/without a worktree commit/);
    expect(() => transitionJob(store, c.id, 'complete', { token: c.token })).toThrow(
      /different commits/,
    );
  });
});

describe('invariant 6: registered artifacts must still match the disk at the gate', () => {
  it('build.md edited after registration cannot complete the stage', () => {
    const c = start();
    go(c, 'start');
    add(c, 'spec.md');
    go(c, 'complete');
    go(c, 'start');
    commitFile(c.wt, 'src/a.ts', 'a');
    add(c, 'build.md');
    writeFileSync(join(c.dir, 'build.md'), fixture('build.md') + '\nedited behind orch\n');
    expect(() => go(c, 'complete')).toThrow(/changed on disk since it was registered/);
    rmSync(join(c.dir, 'build.md'));
    expect(() => go(c, 'complete')).toThrow(/no longer verifies/);
    add(c, 'build.md', fixture('build.md') + '\nround 1 final\n', true);
    expect(go(c, 'complete').stage).toBe('review');
  });

  it('a review file rewritten after its verdict was recorded blocks the round', () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(c, r);
    add(c, 'round-1/consolidated.md');
    writeFileSync(
      join(c.dir, 'round-1', 'review-security.md'),
      fixture('round-1/review-security.md', 'CHANGES'),
    );
    expect(() => go(c, 'complete')).toThrow(/review-security.md changed on disk/);
  });

  it('build.md needs a clean worktree and a HEAD that does not move before completion', () => {
    const c = start();
    go(c, 'start');
    add(c, 'spec.md');
    go(c, 'complete');
    go(c, 'start');
    writeFileSync(join(c.wt, 'wip.ts'), 'wip');
    expect(() => add(c, 'build.md')).toThrow(/uncommitted changes/);
    commitFile(c.wt, 'wip.ts', 'done');
    add(c, 'build.md');
    commitFile(c.wt, 'after.ts', 'after');
    expect(() => go(c, 'complete')).toThrow(/build.md describe/);
  });

  it('workflow artifacts can only be registered or replaced in their own stage and round', () => {
    const c = start();
    toReview(c);
    // build is over: build.md and spec.md are frozen.
    expect(() => add(c, 'spec.md', fixture('spec.md') + 'x\n', true)).toThrow(
      /belongs to the spec stage/,
    );
    expect(() => add(c, 'build.md', fixture('build.md') + 'x\n', true)).toThrow(
      /belongs to the build stage/,
    );
    // Round files are frozen once the round number moves on.
    go(c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(c, r, 'CHANGES');
    add(c, 'round-1/consolidated.md', fixture('round-1/consolidated.md', '1'));
    go(c, 'complete');
    expect(getJob(store.db, c.id).stage).toBe('build');
    expect(() =>
      add(c, 'round-1/consolidated.md', fixture('round-1/consolidated.md', '0'), true),
    ).toThrow(/belongs to the review stage of round 1/);
    expect(() => add(c, 'round-2/review-security.md')).toThrow(/belongs to the review stage/);
    expect(() => add(c, 'decision.md')).toThrow(/belongs to the approve stage/);
    // Free-form evidence is never locked.
    expect(add(c, 'round-1/evidence/notes.md', '# notes\n').marker).toBeNull();
  });

  it('refuses artifact paths that are links leading outside the artifact directory', () => {
    const c = start();
    const outside = tempDir('orch-outside-');
    extra.push(outside);
    writeFileSync(join(outside, 'review-security.md'), fixture('round-1/review-security.md'));
    try {
      symlinkSync(outside, join(c.dir, 'round-1'), 'junction');
    } catch {
      return; // no link support here; nothing to prove
    }
    try {
      toReview(c);
      go(c, 'start');
      expect(() =>
        recordVerdict(store, c.id, { token: c.token, reviewer: 'security', verdict: 'pass' }),
      ).toThrow(/not a link out/);
    } finally {
      rmdirSync(join(c.dir, 'round-1')); // drop the link itself, never its target
    }
  });
});

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

describe('invariants 2 and 14: the initiating checkout, and installed agent drift', () => {
  it('the plan reports files written into the initiating checkout instead of the worktree', () => {
    const c = start();
    expect(planJob(store, c.id).checkoutDirty).toEqual([]);
    writeFileSync(join(clone, 'oops.ts'), 'written to the wrong tree');
    expect(planJob(store, c.id).checkoutDirty).toEqual(['oops.ts']);
    expect(planJob(store, c.id).worktree?.dirty).toEqual([]);
    expect(readdirSync(c.wt)).not.toContain('oops.ts');
  });

  it('orch doctor warns when an installed managed copy no longer matches the repository', () => {
    const claude = tempDir('orch-claude-doctor-');
    extra.push(claude);
    expect(runDoctor(clone, claude).at(-1)).toMatchObject({
      name: 'Skills and agents',
      status: 'warn',
    });
    runInstall({ source: installRoot(), 'claude-dir': claude, agentMethods: ['copy'] });
    expect(runDoctor(clone, claude).at(-1)?.status).toBe('ok');
    const copy = join(claude, 'agents', 'factory-builder.md');
    writeFileSync(copy, readFileSync(copy, 'utf8').replace('Hard rules', 'Soft rules'));
    const check = runDoctor(clone, claude).at(-1);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('agent factory-builder: stale');
    runInstall({ source: installRoot(), 'claude-dir': claude, agentMethods: ['copy'] });
    expect(runDoctor(clone, claude).at(-1)?.status).toBe('ok');
  });
});

describe('invariant 15: the code never force-pushes, merges, or marks ready', () => {
  it('no source file passes a destructive git or gh argument', () => {
    const src = join(installRoot(), 'src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
      }
    };
    walk(src);
    const forbidden = [
      /'push',[^)]*'(--force|-f|--force-with-lease|--delete)'/,
      /'--force-with-lease'/,
      /'reset',\s*'--hard'/,
      /'branch',\s*'(-D|-d|--delete)'/,
      /'pr',\s*'(merge|ready|close)'/,
      /'clean',\s*'-f/,
      /'checkout',\s*'--'/,
      /'stash'/,
    ];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const re of forbidden) expect(text, `${f} matches ${re.source}`).not.toMatch(re);
    }
    expect(files.length).toBeGreaterThan(20);
  });

  it('ensureDraftPr makes PRs as drafts only, and nothing is ever marked ready or merged', () => {
    const c = start();
    toPr(c);
    pushBranch(store, c.id, { token: c.token });
    writeArtifact(c.dir, 'pr.md');
    ensureDraftPr(store, c.id, { token: c.token, bodyFile: join(c.dir, 'pr.md') });
    const calls = shim.read().calls;
    expect(calls.every((x) => !['merge', 'ready', 'close', 'edit'].includes(x[1] ?? ''))).toBe(
      true,
    );
    expect(calls.find((x) => x[1] === 'create')).toContain('--draft');
    expect(listArtifacts(store.db, c.id).find((a) => a.path === 'decision.md')?.head).toBe(
      head(c.wt),
    );
  });
});
