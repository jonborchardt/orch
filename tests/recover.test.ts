/**
 * Recovery passes on ci-stage jobs: nothing while GitHub is unreachable, a single episode as
 * orch-recovery once it answers, a live lease left alone, a lapsed one taken without force, and
 * the worktree's files never touched.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OwnershipError } from '../src/core/errors.ts';
import { RECOVERY_SESSION } from '../src/core/recovery.ts';
import { reconcileCi } from '../src/ops/github.ts';
import { recoverPass } from '../src/ops/recover.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob } from '../src/storage/jobs.ts';
import { type Ctx, head, SESSION, start, toCi } from './drive.ts';
import { checks, clone, ghCalls, job, reconcile, run, shim, store } from './ci-fixture.ts';

const events = (c: Ctx) => listEvents(store.db, c.id, 1000);
const entry = (c: Ctx, pass: ReturnType<typeof recoverPass>) =>
  pass.jobs.find((j) => j.jobId === c.id);

/** The driving session stops with checks pending; its lease lapses (renewed for 0 minutes). */
function stalledInCi(): Ctx & { sha: string } {
  const c = start(store, clone);
  toCi(store, c);
  const sha = head(c.wt);
  checks(sha, [run('test', null, 'queued')]);
  expect(reconcile(c).action).toBe('wait');
  const { token } = claimJob(store, c.id, { session: SESSION, leaseMinutes: 0 });
  return { ...c, token, sha };
}

describe('recovery pass: ci stage after an outage', () => {
  it('does nothing while the probe fails, then completes the job in one episode', () => {
    const c = stalledInCi();

    shim.write({ fail: 'api rate_limit' });
    const before = job(c);
    const n = events(c).length;
    const offline = recoverPass(store);
    expect(offline.online).toBe(false);
    expect(offline.probeError).toContain('simulated failure');
    expect(entry(c, offline)).toMatchObject({ class: 'recoverable', action: 'none' });
    expect(job(c).revision).toBe(before.revision);
    expect(events(c)).toHaveLength(n);

    shim.write({ fail: undefined });
    checks(c.sha, [run('test', 'success')]);
    const online = recoverPass(store);
    expect(online.online).toBe(true);
    expect(entry(c, online)).toMatchObject({ class: 'recoverable', action: 'reconciled' });
    expect(entry(c, online)?.detail).toMatch(/^complete/);
    expect(job(c)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ownerSession: null,
      ownerToken: null,
    });
    const claims = events(c)
      .slice(n)
      .filter((e) => e.type === 'job.claimed');
    expect(claims.map((e) => e.actor)).toEqual([RECOVERY_SESSION]);
    expect(events(c).some((e) => e.type === 'recovery.attempted')).toBe(true);
    expect(ghCalls('create')).toHaveLength(1);
    expect(existsSync(c.wt)).toBe(true);
  });

  it('leaves a live lease alone, takes a lapsed one without force, and keeps the files', () => {
    const c = start(store, clone);
    toCi(store, c);
    checks(head(c.wt), [run('test', null, 'queued')]);
    expect(reconcile(c).action).toBe('wait');

    const before = job(c);
    const n = events(c).length;
    expect(entry(c, recoverPass(store))).toMatchObject({ class: 'active', action: 'none' });
    expect(job(c)).toMatchObject({ revision: before.revision, ownerSession: SESSION });
    expect(events(c)).toHaveLength(n);

    const { token: old } = claimJob(store, c.id, { session: SESSION, leaseMinutes: 0 });
    const dirty = join(c.wt, 'notes-uncommitted.txt');
    writeFileSync(dirty, 'work in progress\n');
    const pass = recoverPass(store);
    expect(entry(c, pass)).toMatchObject({ class: 'recoverable', action: 'reconciled' });
    expect(entry(c, pass)?.detail).toMatch(/^wait/);
    const claim = events(c).find((e) => e.type === 'job.claimed' && e.actor === RECOVERY_SESSION);
    expect(claim?.payload).toMatchObject({ kind: 'reclaim', previousSession: SESSION });
    expect(events(c).find((e) => e.type === 'job.interrupted')?.payload).toMatchObject({
      expired: true,
    });
    // Checks are still pending: the job stays in ci, handed back unowned for the next pass.
    expect(job(c)).toMatchObject({ stage: 'ci', status: 'running', ownerSession: null });
    expect(() => reconcileCi(store, c.id, { token: old })).toThrow(OwnershipError);
    // The worktree is kept and its uncommitted file is untouched.
    expect(existsSync(c.wt)).toBe(true);
    expect(readFileSync(dirty, 'utf8')).toBe('work in progress\n');
  });
});
