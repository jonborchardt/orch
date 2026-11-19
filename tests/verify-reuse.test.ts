/**
 * `orch verify` returns the latest run when it is still valid for the clean HEAD and policy, and
 * runs again for anything else (decision 2026-11-18-verify-reuses-a-valid-run).
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import { pushBranch } from '../src/ops/github.ts';
import { verifyJob } from '../src/ops/verify.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { getJob } from '../src/storage/jobs.ts';
import { listRuns } from '../src/storage/verification.ts';
import { add, go, head, passSpec, simplify, start, toPr, verify } from './drive.ts';
import { commitFile, gitIn, json, orch } from './helpers.ts';
import { clone, inBuild, store } from './verify-fixture.ts';

const runDirs = (id: string) => readdirSync(join(jobArtifactDir(id, store.paths), 'verification'));

describe('verify reuse', () => {
  it('reuses a passed run at the same clean HEAD; refuses dirt and bad tokens first', () => {
    const c = start(store, clone);
    inBuild(c);
    const first = verify(store, c);
    expect(first).toMatchObject({ status: 'passed', reused: false });
    const again = json<{ status: string; reused: boolean; runId: number }>(
      orch(store.home, tmpdir(), ['--json', 'verify', c.id, '--token', c.token]),
    );
    expect(again).toMatchObject({ status: 'passed', reused: true, runId: first.runId });
    expect(listRuns(store.db, c.id)).toHaveLength(1);
    expect(runDirs(c.id)).toEqual([String(first.runId)]);
    // Ownership and cleanliness are checked before reuse is considered.
    expect(orch(store.home, tmpdir(), ['verify', c.id, '--token', 'nope']).code).toBe(4);
    writeFileSync(join(c.wt, 'late.txt'), 'x');
    const dirty = orch(store.home, tmpdir(), ['verify', c.id, '--token', c.token]);
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain('Commit first');
    expect(listRuns(store.db, c.id)).toHaveLength(1);
  });

  it('runs again after a new commit, an amend, or a failed latest run', () => {
    const c = start(store, clone);
    inBuild(c);
    const r1 = verify(store, c);
    commitFile(c.wt, 'src/a.ts', 'export const a = 1;\n');
    const r2 = verify(store, c);
    expect(r2).toMatchObject({ status: 'passed', reused: false });
    expect(r2.runId).not.toBe(r1.runId);
    writeFileSync(join(c.wt, 'src', 'a.ts'), 'export const a = 2;\n');
    gitIn(c.wt, 'add', '-A');
    gitIn(
      c.wt,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--amend',
      '--no-edit',
    );
    const r3 = verify(store, c);
    expect(r3.reused).toBe(false);
    expect(r3.runId).not.toBe(r2.runId);
    commitFile(c.wt, 'marker.txt', 'BREAK\n');
    const failed = verify(store, c);
    expect(failed).toMatchObject({ status: 'failed', reused: false });
    const retry = verify(store, c);
    expect(retry).toMatchObject({ status: 'failed', reused: false });
    expect(retry.runId).not.toBe(failed.runId);
    expect(listRuns(store.db, c.id)).toHaveLength(5);
  });

  it('a simplify that commits nothing reuses the build run', () => {
    const c = start(store, clone);
    passSpec(store, c);
    go(store, c, 'start');
    commitFile(c.wt, 'src/export.ts', '// export\n');
    const build = verify(store, c);
    add(store, c, 'build.md');
    go(store, c, 'complete');
    expect(verifyJob(store, c.id, { token: c.token })).toMatchObject({
      reused: true,
      runId: build.runId,
    });
    simplify(store, c);
    expect(getJob(store.db, c.id).stage).toBe('review');
    expect(listRuns(store.db, c.id)).toHaveLength(1);
  });

  it('a docs-only base integration still needs a new run before push', () => {
    const c = start(store, clone);
    toPr(store, c);
    const before = listRuns(store.db, c.id).length;
    commitFile(clone, 'docs/notes.md', 'upstream\n', 'base: docs');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    expect(integrateBase(store, c.id, { token: c.token }).integration.status).toBe('merged');
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/No valid verification run/);
    const r = verify(store, c);
    expect(r).toMatchObject({ status: 'passed', reused: false, head: head(c.wt) });
    expect(listRuns(store.db, c.id)).toHaveLength(before + 1);
  });
});
