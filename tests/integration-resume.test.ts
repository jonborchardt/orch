/**
 * Base-branch integration: an interrupted integration is reconstructed from Git when the job resumes.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { pushBranch } from '../src/ops/github.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { listIntegrations, startIntegration } from '../src/storage/verification.ts';
import { approve, go, head, passRound, SESSION, start, toPr, toReview, verify } from './drive.ts';
import { gitIn } from './helpers.ts';
import { store, clone, advanceBase, deliver } from './integration-fixture.ts';

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
