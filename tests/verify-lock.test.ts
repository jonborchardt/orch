/**
 * `orch verify` runs checks one at a time per runtime home: a waiting command renews the lease
 * (never the token), a dead holder's lock is taken over, and the lock is always released.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyLockPath } from '../src/core/paths.ts';
import { verifyJob } from '../src/ops/verify.ts';
import { acquireVerifyLock } from '../src/ops/verify-lock.ts';
import { authorize, getJob } from '../src/storage/jobs.ts';
import { listRuns } from '../src/storage/verification.ts';
import { makePolicyRepo, start } from './drive.ts';
import { commitFile, orch, orchAsync } from './helpers.ts';
import { clone, extra, store } from './verify-fixture.ts';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const release = acquireVerifyLock(lock);
    const child = orchAsync(store.home, tmpdir(), ['verify', c.id, '--token', c.token]);
    try {
      await until(() => (getJob(store.db, c.id).leaseExpiresAt ?? '') > before);
      await delay(1500); // the child polls once a second; it must still be waiting
      expect(listRuns(store.db, c.id)).toEqual([]);
    } finally {
      release();
    }
    const r = await child;
    expect(r.err).toContain('waiting');
    expect(r.code).toBe(0);
    expect(listRuns(store.db, c.id).map((x) => x.status)).toEqual(['passed']);
    expect(getJob(store.db, c.id).ownerToken).toBe(c.token);
    expect(() => authorize(store, c.id, { token: c.token })).not.toThrow();
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over a lock whose holder is no longer running', () => {
    const c = start(store, clone);
    const lock = verifyLockPath(store.paths);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(lock, JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }));
    const r = orch(store.home, tmpdir(), ['verify', c.id, '--token', c.token]);
    expect(r.err).not.toContain('waiting');
    expect(r.code).toBe(0);
    expect(existsSync(lock)).toBe(false);
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
});
