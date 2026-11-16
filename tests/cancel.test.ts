/**
 * `orch factory cancel`: one short ownership episode as the calling session, through the same
 * `cancelJob` the dashboard's Cancel uses. A live lease held by another session is exit 4 in every
 * stage (no needs-human exemption) unless --force; a finished job is refused before any claim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NotFoundError, OwnershipError, ValidationError } from '../src/core/errors.ts';
import { FACTORY_HELP } from '../src/cli/factory.ts';
import { cancelJob } from '../src/ops/actions.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import { seedDashboard } from './fixtures/dashboard.ts';
import { json, orch, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const mk = () =>
  createJob(store, {
    title: 'Cancel me',
    repo: 'github.com/acme/alpha',
    repoPath: '/repos/alpha',
    baseBranch: 'main',
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events = (id: string) => listEvents(store.db, id, 100);
/** Owner and lease as printed (the token never leaves the process) and as stored. */
const cleared = (j: Pick<Job, 'id' | 'ownerSession' | 'leaseExpiresAt'>) => [
  j.ownerSession,
  getJob(store.db, j.id).ownerToken,
  j.leaseExpiresAt,
  'ownerToken' in j,
];

/** A job `other` holds with a live lease: started (working), or escalated then re-claimed. */
function heldByOther(stage: 'working' | 'needs-human'): { id: string; token: string } {
  const { id } = mk();
  let { token } = claimJob(store, id, { session: 'other' });
  transitionJob(store, id, 'start', { token });
  if (stage === 'needs-human') {
    // Escalating releases the job; `other` claims it again so the lease is live while it waits.
    transitionJob(store, id, 'escalate', { token, reason: 'stuck' });
    token = claimJob(store, id, { session: 'other' }).token;
  }
  return { id, token };
}

describe('cancelJob (ops)', () => {
  it('claims and cancels as the session, records its reason verbatim, and releases', () => {
    const { id } = mk();
    const r = cancelJob(store, id, { session: 's1', reason: 'not needed' });
    expect(r.job.status).toBe('cancelled');
    expect(cleared(r.job)).toEqual([null, null, null, false]);
    const evs = events(id);
    expect(evs.map((e) => e.type)).toEqual(['job.created', 'job.claimed', 'job.cancelled']);
    expect(evs.slice(1).map((e) => e.actor)).toEqual(['s1', 's1']);
    expect(evs.at(-1)?.payload).toEqual({ stage: 'spec', reason: 'not needed' });
  });

  it('refuses another live lease with exit 4 in a working stage and in needs-human', () => {
    for (const stage of ['working', 'needs-human'] as const) {
      const { id } = heldByOther(stage);
      const before = getJob(store.db, id);
      const count = events(id).length;
      let err: unknown;
      try {
        cancelJob(store, id, { session: 's1', reason: 'nvm' });
      } catch (e) {
        err = e;
      }
      expect(err, stage).toBeInstanceOf(OwnershipError);
      expect((err as OwnershipError).exitCode).toBe(4);
      expect((err as Error).message).toMatch(/Session other holds a live lease/);
      expect((err as Error).message).toContain('--force');
      expect(getJob(store.db, id)).toEqual(before);
      expect(events(id)).toHaveLength(count);
    }
  });

  it('--force takes the job over; the earlier holder is refused afterwards', () => {
    for (const stage of ['working', 'needs-human'] as const) {
      const { id, token } = heldByOther(stage);
      const r = cancelJob(store, id, { session: 's1', reason: 'nvm', force: true });
      expect(r.job.status, stage).toBe('cancelled');
      expect(cleared(r.job)).toEqual([null, null, null, false]);
      expect(() => transitionJob(store, id, 'escalate', { token })).toThrow(OwnershipError);
    }
  });

  it('cancels a job the caller already owns, or whose other lease has expired', async () => {
    const own = mk();
    const { token } = claimJob(store, own.id, { session: 's1' });
    transitionJob(store, own.id, 'start', { token });
    const mine = cancelJob(store, own.id, { session: 's1', reason: 'mine' });
    expect(mine.job.status).toBe('cancelled');
    expect(cleared(mine.job)).toEqual([null, null, null, false]);

    const lapsed = mk();
    claimJob(store, lapsed.id, { session: 'other', leaseMinutes: 0 });
    await sleep(5);
    const r = cancelJob(store, lapsed.id, { session: 's1', reason: 'lapsed' });
    expect(r.job.status).toBe('cancelled');
    expect(cleared(r.job)).toEqual([null, null, null, false]);
  });

  it('refuses a finished job before claiming, and an unknown id', () => {
    const done = mk();
    cancelJob(store, done.id, { session: 's1', reason: 'first' });
    const count = events(done.id).length;
    expect(() => cancelJob(store, done.id, { session: 's1', reason: 'again' })).toThrow(
      /already cancelled/,
    );
    expect(events(done.id)).toHaveLength(count);

    const { completed } = seedDashboard(store, {
      alpha: tempDir('alpha-'),
      beta: tempDir('beta-'),
      gamma: tempDir('gamma-'),
    });
    const n = events(completed).length;
    let err: unknown;
    try {
      cancelJob(store, completed, { session: 's1', reason: 'late' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/already completed/);
    expect(events(completed)).toHaveLength(n);

    expect(() => cancelJob(store, 'job-00000000', { session: 's1', reason: 'x' })).toThrow(
      NotFoundError,
    );
  });
});

describe('orch factory cancel (CLI)', () => {
  const run = (args: string[]) => orch(store.home, store.home, args);

  it('is listed in orch factory --help', () => {
    expect(FACTORY_HELP).toContain('cancel <id> --reason <r> --session <name> [--force]');
  });

  it('cancels as the session and prints the job without its token', () => {
    const { id } = mk();
    const r = run(['--json', 'factory', 'cancel', id, '--reason', 'not needed', '--session', 's1']);
    expect(r.code, r.err).toBe(0);
    const out = json<{ job: Job }>(r);
    expect(out.job.status).toBe('cancelled');
    expect(cleared(out.job)).toEqual([null, null, null, false]);
    expect(r.out).not.toContain('ownerToken');
    expect(events(id).at(-1)).toMatchObject({
      type: 'job.cancelled',
      actor: 's1',
      payload: { reason: 'not needed' },
    });
  });

  it('usage mistakes exit 2 and leave the row alone; another live lease exits 4', () => {
    const { id } = mk();
    const before = getJob(store.db, id);
    for (const args of [
      ['factory', 'cancel', id, '--session', 's1'],
      ['factory', 'cancel', id, '--reason', '  ', '--session', 's1'],
      ['factory', 'cancel', '--reason', 'why', '--session', 's1'],
      ['factory', 'cancel', id, '--reason', 'why'],
    ]) {
      expect(run(args).code, args.join(' ')).toBe(2);
    }
    expect(getJob(store.db, id)).toEqual(before);

    const held = heldByOther('working');
    const r = run(['--json', 'factory', 'cancel', held.id, '--reason', 'why', '--session', 's1']);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/other/);
    expect(r.err).toContain('--force');
    expect(getJob(store.db, held.id).status).not.toBe('cancelled');
  });
});
