/** Runs and Agents read models: aggregates over persisted jobs, events, and reviews. */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROLES } from '../src/core/roles.ts';
import { jobUsage } from '../src/ops/usage.ts';
import { median, timing } from '../src/server/api.ts';
import { type RunningServer, startServer } from '../src/server/http.ts';
import type { AgentsView, RunsView } from '../src/server/types.ts';
import { appendEvent } from '../src/storage/events.ts';
import { claimJob, createJob, listJobs } from '../src/storage/jobs.ts';
import { artifacts, jobs, reviews } from '../src/storage/schema.ts';
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
  it('takes medians and times finished runs', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(timing([10, 0, 30, null])).toEqual({ unmeasured: 2, averageMs: 20, medianMs: 20 });
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
  const ev = (job: string, type: string, min: number, stage?: string) =>
    appendEvent(store.db, job, type, stage ? { stage } : {}, null, at(min * MIN));

  it('puts every role in exactly one list, in ROLES order (AC6, AC9)', async () => {
    const view = await json<AgentsView>('/api/agents');
    const names = [...view.reviewers, ...view.stages].map((r) => r.role);
    expect(names.sort()).toEqual(ROLES.map((r) => r.name).sort());
    const order = (xs: { role: string }[]) =>
      xs.map((r) => ROLES.findIndex((x) => x.name === r.role));
    for (const xs of [view.reviewers, view.stages]) {
      expect(order(xs)).toEqual([...order(xs)].sort((a, b) => a - b));
    }
    expect(view.reviewers.map((r) => r.role)).toContain('spec-challenger');
    for (const r of [...view.reviewers, ...view.stages]) {
      for (const k of ['open', 'invocations', 'measured', 'source'])
        expect(r).not.toHaveProperty(k);
    }
  });

  it('counts reviewer verdicts from review rows, skipping open ones (AC3)', async () => {
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
    const view = await json<AgentsView>('/api/agents');
    expect(view.reviewers.find((r) => r.role === 'security')).toEqual({
      role: 'security',
      runs: 3,
      pass: 2,
      changes: 1,
      unmeasured: 1,
      averageMs: 20 * MIN,
      medianMs: 20 * MIN,
    });
  });

  it('counts spec-challenger runs from registered spec reviews (AC8)', async () => {
    const art = (jobId: string, path: string, marker: string | null) => ({
      jobId,
      stage: 'spec' as const,
      round: null,
      path,
      bytes: 1,
      marker,
      createdAt: at(0),
    });
    const a = seedJob({ createdAt: at(0) });
    const b = seedJob({ createdAt: at(0) });
    store.db
      .insert(artifacts)
      .values([
        art(a, 'spec-review-1.md', 'changes'),
        art(a, 'spec-review-2.md', 'pass'),
        art(a, 'spec.md', null),
        art(a, 'round-1/review-security.md', 'changes'), // a review artifact, not the challenger's
        art(b, 'spec-review-1.md', 'pass'),
      ])
      .run();
    const view = await json<AgentsView>('/api/agents');
    expect(view.stages.map((r) => r.role)).not.toContain('spec-challenger');
    expect(view.reviewers.find((r) => r.role === 'spec-challenger')).toEqual({
      role: 'spec-challenger',
      runs: 3,
      pass: 2,
      changes: 1,
      unmeasured: 3,
      averageMs: null,
      medianMs: null,
    });
  });

  it('maps each stage end to its column and splits builders by mode (AC5)', async () => {
    const full = seedJob({ createdAt: at(0) });
    ev(full, 'stage.started', 0, 'build');
    ev(full, 'stage.completed', 1, 'build');
    ev(full, 'stage.started', 2, 'build');
    ev(full, 'stage.failed', 5, 'build');
    ev(full, 'stage.started', 6, 'build');
    ev(full, 'job.blocked', 10);
    ev(full, 'stage.started', 11, 'build');
    ev(full, 'job.reworked', 12);
    ev(full, 'stage.started', 13, 'build');
    ev(full, 'job.cancelled', 14);
    ev(full, 'stage.started', 15, 'build');
    ev(full, 'job.interrupted', 16);
    ev(full, 'stage.started', 17, 'review'); // review visits belong to no stage role
    ev(full, 'stage.completed', 18, 'review');
    ev(full, 'stage.started', 19, 'build'); // no end yet: not counted
    const fast = seedJob({ createdAt: at(0) }, 'fast');
    ev(fast, 'stage.started', 0, 'build');
    ev(fast, 'stage.completed', 7, 'build');

    const view = await json<AgentsView>('/api/agents');
    const of = (role: string) => view.stages.find((r) => r.role === role);
    const usage = jobUsage(store, full)
      .stages.filter((v) => v.stage === 'build')
      .flatMap((v) => (v.durationMs ? [v.durationMs] : []));
    expect(usage).toEqual([MIN, 3 * MIN, 4 * MIN, MIN, MIN, MIN]);
    expect(of('builder')).toEqual({
      role: 'builder',
      runs: 6,
      completed: 1,
      failed: 1,
      escalated: 1,
      sentBack: 1,
      cancelled: 1,
      interrupted: 1,
      unmeasured: 0,
      averageMs: usage.reduce((a, b) => a + b, 0) / usage.length,
      medianMs: MIN,
    });
    expect(of('fast-builder')).toMatchObject({ runs: 1, completed: 1, medianMs: 7 * MIN });
    for (const r of view.stages) {
      expect(r.runs).toBe(
        r.completed + r.failed + r.escalated + r.sentBack + r.cancelled + r.interrupted,
      );
    }
    for (const r of view.reviewers) expect(r.runs).toBe(r.pass + r.changes);
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
