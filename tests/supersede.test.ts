/**
 * Explicit supersession: one job records the job that replaced it. Nothing is inferred from
 * titles, nothing is deleted or merged, both histories stay, and the relationship is visible on
 * the CLI, the dashboard API, and the job row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { supersede } from '../src/ops/actions.ts';
import { board, detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  claimJob,
  createJob,
  getJob,
  jobDetail,
  predecessorsOf,
  releaseJob,
  supersedeJob,
  transitionJob,
} from '../src/storage/jobs.ts';
import { json, orch, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const mk = (title: string, repo = 'github.com/acme/alpha') =>
  createJob(store, { title, repo, repoPath: `/repos/${repo}`, baseBranch: 'main' });

describe('supersedeJob (storage)', () => {
  it('records the replacement with an event; both jobs keep their rows and histories', () => {
    const old = mk('Export CSV');
    const next = mk('Export CSV');
    const { token } = claimJob(store, old.id, { session: 's1' });
    transitionJob(store, old.id, 'cancel', { token, reason: 'restarting' });
    const updated = supersedeJob(store, old.id, { token }, next.id);
    expect(updated.supersededBy).toBe(next.id);
    expect(updated.status).toBe('cancelled');
    expect(getJob(store.db, next.id).supersededBy).toBeNull();
    expect(predecessorsOf(store.db, next.id).map((j) => j.id)).toEqual([old.id]);
    expect(jobDetail(store, next.id).supersedes).toEqual([old.id]);
    expect(jobDetail(store, old.id).supersedes).toEqual([]);
    const events = listEvents(store.db, old.id, 100).map((e) => e.type);
    expect(events).toEqual(['job.created', 'job.claimed', 'job.cancelled', 'job.superseded']);
    expect(listEvents(store.db, old.id, 100).at(-1)?.payload).toEqual({
      by: next.id,
      previous: null,
    });
    // Changing the replacement later keeps the earlier record in the event log.
    const third = mk('Export CSV, take three');
    supersedeJob(store, old.id, { token }, third.id);
    expect(getJob(store.db, old.id).supersededBy).toBe(third.id);
    expect(listEvents(store.db, old.id, 100).at(-1)?.payload).toEqual({
      by: third.id,
      previous: next.id,
    });
  });

  it('needs the owner token and refuses self, other repositories, unknown jobs, and loops', () => {
    const a = mk('A');
    const b = mk('B');
    const other = mk('C', 'github.com/acme/beta');
    expect(() => supersedeJob(store, a.id, { token: undefined }, b.id)).toThrow(OwnershipError);
    const { token } = claimJob(store, a.id, { session: 's1' });
    expect(() => supersedeJob(store, a.id, { token }, a.id)).toThrow(/cannot supersede itself/);
    expect(() => supersedeJob(store, a.id, { token }, other.id)).toThrow(/belongs to/);
    expect(() => supersedeJob(store, a.id, { token }, 'job-00000000')).toThrow(/No job with id/);
    supersedeJob(store, a.id, { token }, b.id);
    const tb = claimJob(store, b.id, { session: 's1' }).token;
    expect(() => supersedeJob(store, b.id, { token: tb }, a.id)).toThrow(/refusing a loop/);
    // A longer chain is a loop too: c -> a -> b, then b -> c would close it.
    const c = mk('C2');
    const tc = claimJob(store, c.id, { session: 's1' }).token;
    supersedeJob(store, c.id, { token: tc }, a.id);
    expect(() => supersedeJob(store, b.id, { token: tb }, c.id)).toThrow(/refusing a loop/);
    // Rows created before the column existed simply carry null.
    expect(getJob(store.db, other.id).supersededBy).toBeNull();
  });
});

describe('supersede (ops episode) and the CLI', () => {
  it('claims briefly as the given session, records, releases; respects a live lease', () => {
    const old = mk('Old');
    const next = mk('New');
    // Unowned job: a short claim and release, nothing left owned.
    const r = supersede(store, old.id, { by: next.id, session: 'human' });
    expect(r.supersededBy).toBe(next.id);
    expect([r.ownerSession, r.ownerToken]).toEqual([null, null]);
    const types = listEvents(store.db, old.id, 100).map((e) => e.type);
    expect(types).toEqual(['job.created', 'job.claimed', 'job.superseded', 'job.released']);

    // A job another session is working on is not taken over silently.
    const busy = mk('Busy');
    const { token } = claimJob(store, busy.id, { session: 'claude-1' });
    transitionJob(store, busy.id, 'start', { token });
    expect(() => supersede(store, busy.id, { by: next.id, session: 'human' })).toThrow(
      /holds a live lease/,
    );
    expect(getJob(store.db, busy.id).supersededBy).toBeNull();
    expect(
      supersede(store, busy.id, { by: next.id, session: 'human', force: true }).supersededBy,
    ).toBe(next.id);
    // The earlier holder's token is now stale (every claim rotates it).
    expect(() => transitionJob(store, busy.id, 'complete', { token })).toThrow(OwnershipError);
    // A released lease is no obstacle.
    const idle = mk('Idle');
    const t2 = claimJob(store, idle.id, { session: 'claude-2' }).token;
    releaseJob(store, idle.id, { token: t2 });
    expect(supersede(store, idle.id, { by: next.id, session: 'human' }).supersededBy).toBe(next.id);
    expect(() => supersede(store, idle.id, { by: idle.id, session: 'human' })).toThrow(
      ValidationError,
    );
  });

  it('orch job supersede / show / list expose the relationship', () => {
    const old = mk('Old');
    const next = mk('New');
    const r = json<{ job: { supersededBy: string | null } }>(
      orch(store.home, store.home, [
        '--json',
        'job',
        'supersede',
        old.id,
        '--by',
        next.id,
        '--session',
        'human',
      ]),
    );
    expect(r.job.supersededBy).toBe(next.id);
    const shown = json<{ job: { supersededBy: string | null }; supersedes: string[] }>(
      orch(store.home, store.home, ['--json', 'job', 'show', next.id]),
    );
    expect(shown.job.supersededBy).toBeNull();
    expect(shown.supersedes).toEqual([old.id]);
    expect(orch(store.home, store.home, ['job', 'supersede', old.id, '--session', 'h']).code).toBe(
      2,
    );
    expect(orch(store.home, store.home, ['job', 'supersede', old.id, '--by', next.id]).code).toBe(
      2,
    );
    expect(
      orch(store.home, store.home, ['job', 'supersede', old.id, '--by', old.id, '--session', 'h'])
        .code,
    ).toBe(1);
  });
});

describe('dashboard read models', () => {
  it('board rows and the detail view name the replacement in both directions', () => {
    const old = mk('Export CSV');
    const next = mk('Export CSV');
    const unrelated = mk('Export CSV'); // same title, no relationship: none is invented
    supersede(store, old.id, { by: next.id, session: 'human' });
    const rows = board(store);
    const by = (id: string) => rows.find((r) => r.id === id);
    expect(by(old.id)).toMatchObject({ supersededBy: next.id, supersedes: [] });
    expect(by(next.id)).toMatchObject({ supersededBy: null, supersedes: [old.id] });
    expect(by(unrelated.id)).toMatchObject({ supersededBy: null, supersedes: [] });
    expect(detail(store, next.id).supersedes).toEqual([old.id]);
    expect(detail(store, old.id)).toMatchObject({
      supersedes: [],
      job: { supersededBy: next.id },
    });
  });
});
