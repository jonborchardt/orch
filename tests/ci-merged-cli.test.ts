/**
 * CLI side of a PR merged by a human: `orch job transition complete` still refuses a ci job with a
 * stored merge, and `orch worktree remove` without a token cleans up a finished, merged job in a
 * short episode, under the same rule as the dashboard's Remove worktree.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { claimJob, recordCi, releaseJob } from '../src/storage/jobs.ts';
import { type Ctx, head, start, toCi } from './drive.ts';
import { orch } from './helpers.ts';
import { checks, clone, job, reconcile, run, shim, store } from './ci-fixture.ts';

const remove = (c: Ctx) => orch(store.home, tmpdir(), ['worktree', 'remove', c.id]);

/** A ci job completed by `orch gh ci` after a human merged its PR with checks queued. */
function mergedJob(): Ctx {
  const c = start(store, clone);
  toCi(store, c);
  checks(head(c.wt), [run('test', null, 'queued')]);
  const st = shim.read();
  st.prs[0] = { ...st.prs[0], state: 'MERGED' };
  shim.write({ prs: st.prs });
  expect(reconcile(c).action).toBe('complete');
  return c;
}

describe('CLI: a PR merged by a human', () => {
  it('orch job transition complete still refuses a ci job with a stored merge and failing checks', () => {
    const c = start(store, clone);
    toCi(store, c);
    recordCi(store, c.id, {
      token: c.token,
      ciStatus: 'failing',
      prState: 'merged',
      head: head(c.wt),
    });
    const r = orch(store.home, tmpdir(), [
      'job',
      'transition',
      c.id,
      'complete',
      '--token',
      c.token,
    ]);
    expect(r.code).toBe(1);
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running' });

    // Without a token, worktree remove on a running job is refused as before.
    const running = remove(c);
    expect(running.code).toBe(4);
    expect(existsSync(c.wt)).toBe(true);
  });

  it('orch worktree remove without a token removes a finished, merged job worktree', () => {
    const c = mergedJob();
    const branch = job(c).branch;
    // Dirty: refused, nothing removed.
    writeFileSync(join(c.wt, 'stray.txt'), 'x\n');
    const dirty = remove(c);
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain('uncommitted changes');
    expect(existsSync(c.wt)).toBe(true);
    expect(job(c).ownerToken).toBeNull();
    // Another session holds a live lease: ownership refusal.
    const other = claimJob(store, c.id, { session: 'someone-else' });
    expect(remove(c).code).toBe(4);
    releaseJob(store, c.id, { token: other.token });
    // Clean and unowned: removed, branch kept, job left unowned.
    rmSync(join(c.wt, 'stray.txt'));
    const ok = remove(c);
    expect(ok.code, ok.err).toBe(0);
    expect(existsSync(c.wt)).toBe(false);
    expect(job(c)).toMatchObject({
      worktreePath: null,
      branch,
      ownerSession: null,
      ownerToken: null,
      stage: 'completed',
    });
  });

  it('refuses a finished job whose PR is not merged with the rule reason', () => {
    const c = start(store, clone);
    toCi(store, c);
    checks(head(c.wt), [run('test', 'success')]);
    expect(reconcile(c).action).toBe('complete');
    expect(job(c).prState).toBe('ready');
    const r = remove(c);
    expect(r.code).toBe(1);
    expect(r.err).toContain('the PR is ready, not merged');
    expect(existsSync(c.wt)).toBe(true);
  });
});
