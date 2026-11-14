/**
 * Base-branch integration safety: recorded inputs and outcomes, conflict routing through the
 * builder, post-integration verification, resumption from Git, and the final delivery gate.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/core/errors.ts';
import { editedMerges } from '../src/git/worktree.ts';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { getJob } from '../src/storage/jobs.ts';
import { listIntegrations, startIntegration } from '../src/storage/verification.ts';
import {
  add,
  approve,
  type Ctx,
  go,
  head,
  makePolicyRepo,
  passRound,
  prBody,
  prFile,
  SESSION,
  start,
  toPr,
  toReview,
  verify,
} from './drive.ts';
import {
  commitFile,
  fixture,
  type GhShim,
  ghShim,
  gitIn,
  type TempStore,
  tempStore,
  writeArtifact,
} from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
let shim: GhShim;

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
  ({ clone, bare } = makePolicyRepo());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
});

/** Advance main on origin with a commit to `file`. */
function advanceBase(file: string, body: string): string {
  const sha = commitFile(clone, file, body, `base: ${file}`);
  gitIn(clone, 'push', '-q', 'origin', 'main');
  return sha;
}

function deliver(c: Ctx): void {
  pushBranch(store, c.id, { token: c.token });
  writeArtifact(c.dir, 'pr.md', prBody(store, c));
  ensureDraftPr(store, c.id, { token: c.token, bodyFile: prFile(c) });
  add(store, c, 'pr.md', prBody(store, c));
  expect(go(store, c, 'complete').stage).toBe('ci');
}

describe('clean and no-op integration', () => {
  it('records inputs and outcome, requires fresh verification, then delivers a draft PR', () => {
    const c = start(store, clone);
    toPr(store, c);
    const approvedHead = head(c.wt);
    const baseSha = advanceBase('docs/notes.md', 'upstream\n');
    expect(planJob(store, c.id).worktree?.behind).toBe(1);
    expect(planJob(store, c.id).commands.some((x) => x.includes('worktree integrate'))).toBe(true);
    // Stale evidence (HEAD will move) is refused before anything is pushed.
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration.status).toBe('merged');
    expect(r.next).toBe('verify');
    expect(r.integration).toMatchObject({
      fromHead: approvedHead,
      baseSha,
      decisionHead: approvedHead,
      material: [],
      conflicts: [],
      changedFiles: ['docs/notes.md'],
    });
    expect(r.integration.verificationRunId).not.toBeNull();
    expect(r.integration.resultHead).toBe(head(c.wt));
    expect(getJob(store.db, c.id).stage).toBe('pr');
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/No valid verification run/);
    expect(gitIn(bare, 'branch', '--list', 'factory/*')).toBe('');
    expect(planJob(store, c.id).commands).toContain(`orch verify ${c.id} --token <token>`);
    expect(verify(store, c).status).toBe('passed');
    deliver(c);
    expect(shim.read().prs).toHaveLength(1);
    expect(gitIn(bare, 'rev-parse', `refs/heads/${getJob(store.db, c.id).branch ?? ''}`)).toBe(
      head(c.wt),
    );
    const rows = listIntegrations(store.db, c.id);
    expect(rows.map((x) => x.status)).toEqual(['merged']);
  });

  it('a no-op integration is recorded as up-to-date and keeps valid evidence', () => {
    const c = start(store, clone);
    toPr(store, c);
    const before = head(c.wt);
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration.status).toBe('up-to-date');
    expect(r.merge.upToDate).toBe(true);
    expect(r.next).toBe('none');
    expect(head(c.wt)).toBe(before);
    expect(planJob(store, c.id).verification?.valid).toBe(true);
    // Duplicate attempts just add up-to-date rows; nothing merges twice.
    integrateBase(store, c.id, { token: c.token });
    expect(listIntegrations(store.db, c.id).map((x) => x.status)).toEqual([
      'up-to-date',
      'up-to-date',
    ]);
    expect(gitIn(c.wt, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
    deliver(c);
  });

  it('post-integration verification fails when the base broke the checks; nothing is pushed', () => {
    const c = start(store, clone);
    toPr(store, c);
    advanceBase('marker.txt', 'BREAK\n');
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration.status).toBe('merged');
    expect(verify(store, c).status).toBe('failed');
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/a required check failed/);
    expect(() => go(store, c, 'complete')).toThrow(/a required check failed/);
    expect(gitIn(bare, 'branch', '--list', 'factory/*')).toBe('');
  });
});

describe('conflicts and material edits', () => {
  it('a conflicting merge is aborted, recorded, and sends the job back to build', () => {
    const c = start(store, clone);
    toReview(store, c, 'src/app.ts');
    passRound(store, c);
    approve(store, c);
    go(store, c, 'start');
    const before = head(c.wt);
    advanceBase('src/app.ts', 'export const app = 2; // base\n');
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration.status).toBe('conflict');
    expect(r.integration.conflicts).toEqual(['src/app.ts']);
    expect(r.next).toBe('rework');
    expect(head(c.wt)).toBe(before);
    expect(planJob(store, c.id).worktree?.dirty).toEqual([]);
    expect(existsSync(join(c.wt, '.git'))).toBe(true);
    const job = getJob(store.db, c.id);
    expect([job.stage, job.status]).toEqual(['build', 'pending']);
    expect(planJob(store, c.id).reason).toContain('conflicts in src/app.ts');
    // The builder resolves: merge, fix, commit; then the normal gates apply again.
    go(store, c, 'start');
    expect(() => gitIn(c.wt, 'merge', '--no-edit', 'origin/main')).toThrow();
    writeFileSync(join(c.wt, 'src', 'app.ts'), 'export const app = 3; // resolved\n');
    gitIn(c.wt, 'add', 'src/app.ts');
    gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'merge base');
    expect(editedMerges(c.wt, before, head(c.wt)).map((m) => m.files)).toEqual([['src/app.ts']]);
    expect(verify(store, c).status).toBe('passed');
    add(store, c, 'build.md', fixture('build.md') + '\nresolved\n', true);
    expect(go(store, c, 'complete').round).toBe(2);
    passRound(store, c);
    approve(store, c, true);
    go(store, c, 'start');
    const again = integrateBase(store, c.id, { token: c.token });
    expect(again.integration.status).toBe('up-to-date');
    // The approval now covers the resolution commit itself, so the merge-edit rule is satisfied.
    deliver(c);
    expect(listIntegrations(store.db, c.id).map((x) => x.status)).toEqual([
      'up-to-date',
      'conflict',
    ]);
  });

  it('a merge commit with edits beyond either parent cannot be pushed and is routed to rework', () => {
    const c = start(store, clone);
    toPr(store, c);
    const approved = head(c.wt);
    advanceBase('docs/notes.md', 'upstream\n');
    // Someone merges by hand and slips an edit into the merge commit.
    gitIn(c.wt, 'merge', '--no-commit', '--no-ff', 'origin/main');
    writeFileSync(join(c.wt, 'src', 'app.ts'), 'export const app = 99; // smuggled\n');
    gitIn(c.wt, 'add', '-A');
    gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'merge with edit');
    expect(editedMerges(c.wt, approved, head(c.wt))[0]?.files).toEqual(['src/app.ts']);
    verify(store, c);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/match neither parent/);
    expect(() =>
      ensureDraftPr(store, c.id, { token: c.token, bodyFile: join(c.dir, 'spec.md') }),
    ).toThrow(/match neither parent/);
    // integrateBase sees nothing to merge, but the plan still cannot deliver without review.
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration.status).toBe('up-to-date');
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/match neither parent/);
  });

  it('outside the pr stage a conflict is an error and the worktree is left untouched', () => {
    const c = start(store, clone);
    toReview(store, c, 'src/app.ts');
    const before = head(c.wt);
    advanceBase('src/app.ts', 'export const app = 2;\n');
    expect(() => integrateBase(store, c.id, { token: c.token })).toThrow(ToolError);
    expect(head(c.wt)).toBe(before);
    expect(getJob(store.db, c.id).stage).toBe('review');
    expect(listIntegrations(store.db, c.id)[0]?.status).toBe('conflict');
  });
});

describe('interruption and resumption', () => {
  it('a row left started with nothing merged is marked interrupted; the merge then proceeds', () => {
    const c = start(store, clone);
    toPr(store, c);
    advanceBase('docs/a.md', 'a\n');
    startIntegration(store, c.id, {
      token: c.token,
      fromHead: head(c.wt),
      baseRef: 'origin/main',
      baseSha: gitIn(clone, 'rev-parse', 'main'),
      mergeBase: null,
      decisionHead: null,
      verificationRunId: null,
    });
    const resumed = resumeFactoryJob(store, c.id, { session: SESSION });
    const c2 = { ...c, token: resumed.token };
    expect(resumed.plan.integration?.status).toBe('started');
    const r = integrateBase(store, c2.id, { token: c2.token });
    expect(r.integration.status).toBe('merged');
    expect(listIntegrations(store.db, c.id).map((x) => x.status)).toEqual([
      'merged',
      'interrupted',
    ]);
  });

  it('a half-done merge (MERGE_HEAD present) is aborted before a fresh attempt', () => {
    const c = start(store, clone);
    toReview(store, c, 'src/app.ts');
    passRound(store, c);
    approve(store, c);
    go(store, c, 'start');
    const before = head(c.wt);
    advanceBase('src/app.ts', 'export const app = 2; // base\n');
    startIntegration(store, c.id, {
      token: c.token,
      fromHead: before,
      baseRef: 'origin/main',
      baseSha: gitIn(clone, 'rev-parse', 'main'),
      mergeBase: null,
      decisionHead: null,
      verificationRunId: null,
    });
    expect(() => gitIn(c.wt, 'merge', '--no-commit', 'origin/main')).toThrow(); // conflict, in progress
    expect(existsSync(join(gitIn(c.wt, 'rev-parse', '--git-dir'), 'MERGE_HEAD'))).toBe(true);
    const r = integrateBase(store, c.id, { token: c.token });
    expect(listIntegrations(store.db, c.id).map((x) => x.status)).toEqual([
      'conflict',
      'interrupted',
    ]);
    expect(r.integration.status).toBe('conflict');
    expect(head(c.wt)).toBe(before);
    expect(planJob(store, c.id).worktree?.dirty).toEqual([]);
  });

  it('a merge that completed but was never recorded is recorded from Git, not merged again', () => {
    const c = start(store, clone);
    toPr(store, c);
    const from = head(c.wt);
    const baseSha = advanceBase('docs/b.md', 'b\n');
    startIntegration(store, c.id, {
      token: c.token,
      fromHead: from,
      baseRef: 'origin/main',
      baseSha,
      mergeBase: null,
      decisionHead: from,
      verificationRunId: null,
    });
    gitIn(c.wt, 'merge', '--no-edit', '--no-ff', 'origin/main'); // the crash happened right after this
    const merged = head(c.wt);
    const r = integrateBase(store, c.id, { token: c.token });
    const rows = listIntegrations(store.db, c.id);
    expect(rows.map((x) => x.status)).toEqual(['up-to-date', 'merged']);
    expect(rows[1]?.resultHead).toBe(merged);
    expect(rows[1]?.changedFiles).toEqual(['docs/b.md']);
    expect(r.integration.status).toBe('up-to-date');
    expect(head(c.wt)).toBe(merged);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/No valid verification run/);
    verify(store, c);
    deliver(c);
  });

  it('after verification but before delivery, a resumed session delivers without re-merging', () => {
    const c = start(store, clone);
    toPr(store, c);
    advanceBase('docs/c.md', 'c\n');
    integrateBase(store, c.id, { token: c.token });
    verify(store, c);
    const merged = head(c.wt);
    const resumed = resumeFactoryJob(store, c.id, { session: 'claude-later-0002', force: true });
    const c2 = { ...c, token: resumed.token };
    expect(resumed.plan.verification?.valid).toBe(true);
    expect(resumed.plan.worktree?.behind).toBe(0);
    expect(resumed.plan.commands.some((x) => x.includes('worktree integrate'))).toBe(false);
    go(store, c2, 'start');
    deliver(c2);
    expect(head(c.wt)).toBe(merged);
  });
});
