/**
 * `orch verify` runs checks one at a time per runtime home: a waiting command renews the lease
 * (never the token), a dead holder's lock is taken over, and the lock is always released.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyLockPath, verifyQueueDir } from '../src/core/paths.ts';
import { planJob } from '../src/ops/factory.ts';
import { showVerification, verifyJob } from '../src/ops/verify.ts';
import { acquireVerifyLock, alive, verifyQueueState } from '../src/ops/verify-lock.ts';
import { authorize, getJob } from '../src/storage/jobs.ts';
import { listRuns } from '../src/storage/verification.ts';
import { makePolicyRepo, start } from './drive.ts';
import { commitFile, json, orch, orchAsync } from './helpers.ts';
import { clone, extra, store } from './verify-fixture.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entries = () => {
  const dir = verifyQueueDir(store.paths);
  return existsSync(dir) ? readdirSync(dir) : [];
};
const queueOf = (id: string) => showVerification(store, id)?.queue ?? null;
// A PID no live process can hold on any platform (Linux pid_max <= 2^22, Windows PIDs are far
// lower). A just-exited child's PID is not dead for long: Windows reuses it under load.
const DEAD_PID = 2 ** 31 - 1;

async function until(cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await delay(100);
  }
}

describe('verify lock', () => {
  it('waits while another verification holds the lock, renewing the lease but keeping the token', async () => {
    const c = start(store, clone);
    const lock = verifyLockPath(store.paths);
    const before = getJob(store.db, c.id).leaseExpiresAt ?? '';
    const release = acquireVerifyLock(lock, { jobId: 'job-holder' });
    const child = orchAsync(store.home, tmpdir(), ['verify', c.id, '--token', c.token]);
    try {
      await until(() => (getJob(store.db, c.id).leaseExpiresAt ?? '') > before);
      await until(() => queueOf(c.id) !== null);
      await delay(1500); // the child polls once a second; it must still be waiting
      expect(listRuns(store.db, c.id)).toEqual([]);
      // Queued, visibly: in `orch verify show` and in the plan.
      const shown = json<{ queue: unknown }>(
        orch(store.home, tmpdir(), ['--json', 'verify', 'show', c.id]),
      );
      expect(shown.queue).toMatchObject({
        state: 'queued',
        holderJobId: 'job-holder',
        ahead: 0,
        since: expect.any(String) as unknown,
      });
      expect(planJob(store, c.id).verification?.queue).toMatchObject({ state: 'queued' });
    } finally {
      release();
    }
    const r = await child;
    expect(r.err).toContain('waiting for another verification to finish (job job-holder, pid');
    expect(queueOf(c.id)).toBeNull();
    expect(entries()).toEqual([]);
    expect(r.code).toBe(0);
    expect(listRuns(store.db, c.id).map((x) => x.status)).toEqual(['passed']);
    expect(getJob(store.db, c.id).ownerToken).toBe(c.token);
    expect(() => authorize(store, c.id, { token: c.token })).not.toThrow();
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over a lock whose holder is no longer running', () => {
    const c = start(store, clone);
    const lock = verifyLockPath(store.paths);
    const dead = DEAD_PID;
    expect(alive(dead)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }));
    const r = orch(store.home, tmpdir(), ['verify', c.id, '--token', c.token]);
    expect(r.err).not.toContain('waiting');
    expect(r.code).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('reusing a still-valid run never waits for the lock', () => {
    const c = start(store, clone);
    const first = verifyJob(store, c.id, { token: c.token });
    const held = acquireVerifyLock(verifyLockPath(store.paths), { jobId: 'job-holder' });
    try {
      const r = orch(store.home, tmpdir(), ['--json', 'verify', c.id, '--token', c.token]);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain('waiting');
      expect(json(r)).toMatchObject({ reused: true, runId: first.runId });
    } finally {
      held();
    }
  });

  it('releases the lock when a check fails or verification throws; no policy never takes it', () => {
    const c = start(store, clone);
    const lock = verifyLockPath(store.paths);
    commitFile(c.wt, 'marker.txt', 'BREAK\n');
    expect(verifyJob(store, c.id, { token: c.token }).status).toBe('failed');
    expect(existsSync(lock)).toBe(false);
    // The worktree gets dirty while waiting: the recheck under the lock throws, and releases it.
    const release = acquireVerifyLock(lock);
    const waiting = () => {
      writeFileSync(join(c.wt, 'late.txt'), 'x');
      release();
    };
    expect(() =>
      verifyJob(store, c.id, { token: c.token }, { onWait: waiting, pollMs: 10 }),
    ).toThrow(/Commit first/);
    expect(existsSync(lock)).toBe(false);
    expect(entries()).toEqual([]);
    // configuration-required returns at once even while another process would hold the lock.
    const plain = makePolicyRepo('https://github.com/acme/plain.git', null);
    extra.push(plain.clone, plain.bare);
    const p = start(store, plain.clone, 'No policy');
    const held = acquireVerifyLock(lock);
    try {
      expect(verifyJob(store, p.id, { token: p.token }).status).toBe('configuration-required');
    } finally {
      held();
    }
  });

  it('reports the holder as running, and drops the queue entry when a waiter throws', () => {
    const c = start(store, clone);
    const lock = verifyLockPath(store.paths);
    const release = acquireVerifyLock(lock, { jobId: c.id });
    expect(queueOf(c.id)).toMatchObject({ state: 'running', holderJobId: c.id, ahead: 0 });
    expect(planJob(store, c.id).verification?.queue?.state).toBe('running');
    const dir = verifyQueueDir(store.paths);
    expect(verifyQueueState(lock, dir, 'job-other')).toBeNull();
    // A waiter that throws while waiting leaves no queue entry behind.
    expect(() =>
      acquireVerifyLock(lock, {
        jobId: 'job-other',
        queueDir: dir,
        onWait: () => {
          expect(verifyQueueState(lock, dir, 'job-other')).toMatchObject({
            state: 'queued',
            holderJobId: c.id,
          });
          throw new Error('gave up');
        },
      }),
    ).toThrow('gave up');
    expect(entries()).toEqual([]);
    release();
    expect(queueOf(c.id)).toBeNull();
  });

  it('never reports a dead holder or waiter as running or queued', () => {
    const c = start(store, clone);
    const dead = DEAD_PID;
    expect(alive(dead)).toBe(false);
    const dir = verifyQueueDir(store.paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      verifyLockPath(store.paths),
      JSON.stringify({ pid: dead, startedAt: new Date().toISOString(), jobId: c.id }),
    );
    writeFileSync(
      join(dir, `${c.id}.${String(dead)}.json`),
      JSON.stringify({ pid: dead, jobId: c.id, since: new Date().toISOString() }),
    );
    expect(queueOf(c.id)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  it('an old lock without a job still blocks, and reports the holder job as unknown', () => {
    const c = start(store, clone);
    const lock = verifyLockPath(store.paths);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let notice = '';
    let queued: unknown = null;
    const r = verifyJob(
      store,
      c.id,
      { token: c.token },
      {
        pollMs: 10,
        onWait: (m) => {
          notice = m;
          queued = queueOf(c.id);
          rmSync(lock); // the holder finishes
        },
      },
    );
    expect(r.status).toBe('passed');
    expect(notice).toMatch(/\(pid \d+\)/);
    expect(queued).toMatchObject({ state: 'queued', holderJobId: null });
    expect(entries()).toEqual([]);
  });
});
