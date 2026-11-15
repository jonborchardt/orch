/**
 * Phase 5A adversarial cases: each test is a way the factory could have been driven past one of
 * its guarantees, and the refusal that now stops it. Real temporary repositories throughout: an
 * initiating checkout with a local bare origin, and the job's managed worktree under ORCH_HOME.
 */
import * as drive from './drive.ts';
import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/cli/doctor.ts';
import { runInstall } from '../src/cli/install.ts';
import { WorkflowError } from '../src/core/errors.ts';
import { installRoot } from '../src/core/paths.ts';
import { planJob } from '../src/ops/factory.ts';
import { recordVerdict } from '../src/ops/gates.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { listArtifacts } from '../src/storage/artifacts.ts';
import {
  getJob,
  listReviews,
  recordReview as storageRecordReview,
  transitionJob,
} from '../src/storage/jobs.ts';
import { head } from './drive.ts';
import { commitFile, fixture, gitIn, removeLink, tempDir, writeArtifact } from './helpers.ts';
import {
  store,
  clone,
  shim,
  extra,
  start,
  go,
  add,
  verdict,
  toReview,
  toPr,
} from './audit-fixture.ts';

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
      removeLink(join(c.dir, 'round-1')); // drop the link itself, never its target
    }
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

describe('a review round is the required reviewers judging the built commit', () => {
  it('verdicts all given against a commit made after build.md cannot complete the round', () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    const built = head(c.wt);
    // A reviewer (or anyone) commits before the verdicts; every verdict then agrees on the new HEAD.
    commitFile(c.wt, 'src/reviewer-edit.ts', '// written during review\n');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(c, r);
    add(c, 'round-1/consolidated.md', drive.consolidated(store, c));
    expect(head(c.wt)).not.toBe(built);
    expect(() => go(c, 'complete')).toThrow(
      /build.md describes .* the code changed after the build/,
    );
    expect(getJob(store.db, c.id).stage).toBe('review');
  });

  it("a verdict is read from the reviewer's own file only", () => {
    const c = start();
    toReview(c);
    go(c, 'start');
    // Only correctness wrote a file; security's verdict cannot borrow it.
    writeArtifact(c.dir, 'round-1/review-correctness.md', fixture('round-1/review-correctness.md'));
    recordVerdict(store, c.id, { token: c.token, reviewer: 'correctness', verdict: 'pass' });
    expect(() =>
      recordVerdict(store, c.id, { token: c.token, reviewer: 'security', verdict: 'pass' }),
    ).toThrow(/review-security\.md/);
  });
});
