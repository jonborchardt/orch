/**
 * Base drift during approval: a conflicting integration in the approve stage reworks to build
 * directly, with no escalate/resume detour in the history.
 */
import { describe, expect, it } from 'vitest';
import { planJob } from '../src/ops/factory.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import { go, head, passRound, start, toReview } from './drive.ts';
import { store, clone, advanceBase } from './integration-fixture.ts';

describe('base integration in the approve stage', () => {
  it('a conflict reworks to build without escalating', () => {
    const c = start(store, clone);
    toReview(store, c, 'src/app.ts');
    passRound(store, c);
    go(store, c, 'start');
    const startedAt = Math.max(...listEvents(store.db, c.id, 1000).map((e) => e.id));
    const before = head(c.wt);
    advanceBase('src/app.ts', 'export const app = 2; // base\n');
    const plan = planJob(store, c.id);
    expect(plan.reason).toContain(`orch worktree integrate ${c.id}`);
    expect(plan.reason).toContain('back to build');
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration.status).toBe('conflict');
    expect(r.next).toBe('rework');
    expect(head(c.wt)).toBe(before);
    expect(planJob(store, c.id).worktree?.dirty).toEqual([]);
    const job = getJob(store.db, c.id);
    expect([job.stage, job.status]).toEqual(['build', 'pending']);
    const types = listEvents(store.db, c.id, 1000)
      .filter((e) => e.id > startedAt)
      .map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['integration.started', 'integration.completed', 'job.reworked']),
    );
    for (const t of ['stage.failed', 'job.blocked', 'job.resumed']) expect(types).not.toContain(t);
    expect(planJob(store, c.id).reason).toContain('conflicts in src/app.ts');
  });

  it('the approve plan mentions integration only when the base advanced', () => {
    const c = start(store, clone);
    toReview(store, c);
    passRound(store, c);
    expect(planJob(store, c.id).reason).not.toContain('worktree integrate');
  });
});
