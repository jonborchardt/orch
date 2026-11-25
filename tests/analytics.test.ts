/** Runs and Agents read models: aggregates over persisted jobs, events, and reviews. */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROLES } from '../src/core/roles.ts';
import { jobUsage } from '../src/ops/usage.ts';
import { agentRow, median } from '../src/server/api.ts';
import { type RunningServer, startServer } from '../src/server/http.ts';
import type { AgentRow, RunsView } from '../src/server/types.ts';
import { appendEvent } from '../src/storage/events.ts';
import { claimJob, createJob, listJobs } from '../src/storage/jobs.ts';
import { jobs, reviews } from '../src/storage/schema.ts';
import { tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let server: RunningServer;
beforeEach(async () => {
  store = tempStore();
  server = await startServer({ store, port: 0, webRoot: tempDir('orch-web-') });
});
afterEach(async () => {
  await server.close();
  store.cleanup();
});

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(T0 + ms).toISOString();

const get = (path: string) =>
  fetch(new URL(path, server.url), { headers: { Connection: 'close' } });
async function json<T>(path: string): Promise<T> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

let n = 0;
function seedJob(
  over: Partial<typeof jobs.$inferInsert> & { createdAt: string },
  mode: 'full' | 'fast' = 'full',
): string {
  n += 1;
  const job = createJob(store, {
    title: `Job ${String(n)}`,
    description: 'Seeded',
    repo: 'github.com/acme/alpha',
    repoPath: '/repos/alpha',
    baseBranch: 'main',
    mode,
  });
  store.db.update(jobs).set(over).where(eq(jobs.id, job.id)).run();
  return job.id;
}

function seedRuns() {
  seedJob({ status: 'completed', createdAt: at(0), completedAt: at(HOUR) }); // 1h
  seedJob({ status: 'completed', createdAt: at(HOUR), completedAt: at(3 * HOUR) }); // 2h
  seedJob({ status: 'completed', createdAt: at(2 * HOUR) }); // no finish known
  const byEvent = seedJob({ status: 'completed', createdAt: at(3 * HOUR) });
  appendEvent(store.db, byEvent, 'job.completed', {}, null, at(9 * HOUR)); // 6h
  // Finishes after every completed job; must not move the per-hour window's end.
  seedJob({ status: 'cancelled', createdAt: at(HOUR), completedAt: at(10 * HOUR) });
  seedJob({ status: 'failed', createdAt: at(HOUR / 2) });
  seedJob({ status: 'pending', createdAt: at(HOUR / 2) });
}

describe('pure helpers', () => {
  it('takes medians and folds invocations', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(
      agentRow('x', 'stage', [
        { outcome: 'success', ms: 10 },
        { outcome: 'failure', ms: 0 },
        { outcome: 'other', ms: 30 },
        { outcome: 'open', ms: null },
      ]),
    ).toEqual({
      role: 'x',
      source: 'stage',
      invocations: 4,
      success: 1,
      failure: 1,
      other: 1,
      open: 1,
      measured: 2,
      unmeasured: 2,
      averageMs: 20,
      medianMs: 20,
    });
  });
});

describe('GET /api/runs', () => {
  it('counts jobs and measures completed durations (AC1, AC2)', async () => {
    seedRuns();
    const r = await json<RunsView>('/api/runs');
    expect(r).toEqual({
      total: 7,
      completed: 4,
      cancelled: 1,
      active: 2,
      completionRate: 4 / 5,
      durationMs: { average: 3 * HOUR, median: 2 * HOUR },
      durationUnknown: 1,
      // Earliest creation T0 to the latest completed finish T0+9h; the cancelled 10h is ignored.
      completedPerHour: 4 / 9,
    });
  });

  it('reports nulls, never 0 or NaN, on an empty store (AC2)', async () => {
    expect(await json<RunsView>('/api/runs')).toEqual({
      total: 0,
      completed: 0,
      cancelled: 0,
      active: 0,
      completionRate: null,
      durationMs: { average: null, median: null },
      durationUnknown: 0,
      completedPerHour: null,
    });
  });
});

describe('GET /api/agents', () => {
  it('has one row per role, reviews from review rows (AC3)', async () => {
    const id = seedJob({ createdAt: at(0) });
    const row = (round: number, verdict: 'pass' | 'changes' | null, from: number, to?: number) => ({
      jobId: id,
      round,
      reviewer: 'security',
      verdict,
      createdAt: at(from),
      completedAt: to === undefined ? null : at(to),
    });
    store.db
      .insert(reviews)
      .values([
        row(1, null, 0),
        row(2, 'pass', 0, 10 * MIN),
        row(3, 'changes', 0, 30 * MIN),
        row(4, 'pass', 5 * MIN, 5 * MIN), // recorded without a pending row: zero-length
      ])
      .run();
    const rows = await json<AgentRow[]>('/api/agents');
    expect(rows.map((r) => r.role)).toEqual(ROLES.map((r) => r.name));
    expect(rows.every((r) => ['reviews', 'stage', 'none'].includes(r.source))).toBe(true);
    expect(rows.find((r) => r.role === 'security')).toEqual({
      role: 'security',
      source: 'reviews',
      invocations: 4,
      success: 2,
      failure: 1,
      other: 0,
      open: 1,
      measured: 2,
      unmeasured: 2,
      averageMs: 20 * MIN,
      medianMs: 20 * MIN,
    });
  });

  it('counts stage visits by mode and leaves spec-challenger unrecorded (AC4)', async () => {
    const full = seedJob({ createdAt: at(0) });
    const ev = (job: string, type: string, min: number, stage?: string) =>
      appendEvent(store.db, job, type, stage ? { stage } : {}, null, at(min * MIN));
    ev(full, 'stage.started', 0, 'build');
    ev(full, 'stage.completed', 1, 'build');
    ev(full, 'stage.started', 2, 'build');
    ev(full, 'stage.failed', 5, 'build');
    ev(full, 'stage.started', 6, 'build');
    ev(full, 'job.reworked', 10);
    ev(full, 'stage.started', 11, 'review'); // review visits belong to no stage role
    ev(full, 'stage.completed', 12, 'review');
    ev(full, 'stage.started', 13, 'build');
    const fast = seedJob({ createdAt: at(0) }, 'fast');
    ev(fast, 'stage.started', 0, 'build');
    ev(fast, 'stage.completed', 7, 'build');

    const rows = await json<AgentRow[]>('/api/agents');
    const of = (role: string) => rows.find((r) => r.role === role);
    const usage = jobUsage(store, full)
      .stages.filter((v) => v.stage === 'build')
      .flatMap((v) => (v.durationMs ? [v.durationMs] : []));
    expect(usage).toEqual([MIN, 3 * MIN, 4 * MIN]);
    expect(of('builder')).toEqual({
      role: 'builder',
      source: 'stage',
      invocations: 4,
      success: 1,
      failure: 1,
      other: 1,
      open: 1,
      measured: 3,
      unmeasured: 1,
      averageMs: usage.reduce((a, b) => a + b, 0) / usage.length,
      medianMs: 3 * MIN,
    });
    expect(of('fast-builder')).toMatchObject({ invocations: 1, success: 1, medianMs: 7 * MIN });
    expect(of('spec-challenger')).toEqual({
      role: 'spec-challenger',
      source: 'none',
      invocations: 0,
      success: 0,
      failure: 0,
      other: 0,
      open: 0,
      measured: 0,
      unmeasured: 0,
      averageMs: null,
      medianMs: null,
    });
    for (const r of rows) expect(r.invocations).toBe(r.success + r.failure + r.other + r.open);
  });
});

describe('analytics reads are safe (AC5)', () => {
  it('never exposes owner tokens and never changes a job', async () => {
    seedRuns();
    const claimed = seedJob({ createdAt: at(0) });
    claimJob(store, claimed, { session: 's1' });
    const before = listJobs(store.db);
    for (const path of ['/api/runs', '/api/agents']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('ownerToken');
    }
    expect(listJobs(store.db)).toEqual(before);
  });
});
