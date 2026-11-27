/** Runs and Agents read models: aggregates over persisted jobs, events, and reviews. */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROLES } from '../src/core/roles.ts';
import { MAX_ROUNDS_REASON } from '../src/core/workflow.ts';
import { cancelJob } from '../src/ops/actions.ts';
import { jobUsage } from '../src/ops/usage.ts';
import { median, timing } from '../src/server/api.ts';
import { health } from '../src/server/health.ts';
import { type RunningServer, startServer } from '../src/server/http.ts';
import { rangeOf } from '../src/server/token-usage.ts';
import type { AgentsView, HealthView, RunsView } from '../src/server/types.ts';
import { appendEvent } from '../src/storage/events.ts';
import { claimJob, createJob, getJob, listJobs } from '../src/storage/jobs.ts';
import { artifacts, events, jobs, reviews } from '../src/storage/schema.ts';
import { createTicket } from '../src/storage/tickets.ts';
import { insertUsage } from '../src/storage/usage.ts';
import * as drive from './drive.ts';
import { commitFile, fixture, tempDir, type TempStore, tempStore } from './helpers.ts';

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

describe('GET /api/agents per model (ticket 0169, AC4)', () => {
  let repo: { clone: string; bare: string };
  beforeEach(() => {
    repo = drive.makePolicyRepo();
  });
  afterEach(() => {
    for (const d of [repo.clone, repo.bare]) rmSync(d, { recursive: true, force: true });
  });
  const config = (models: Record<string, unknown>) => {
    writeFileSync(join(store.paths.config, 'factory.json'), JSON.stringify({ models }));
  };
  /** One review round: `changes` ask for changes; `findings[k]` raised blocking finding k+1. */
  function round(c: drive.Ctx, changes: string[], findings: string[]): void {
    drive.go(store, c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) {
      drive.verdict(store, c, r, changes.includes(r) ? 'CHANGES' : 'PASS');
    }
    const n = String(getJob(store.db, c.id).round);
    const lines = findings.map(
      (who, i) => `${String(i + 1)}. [BLOCKING] f — p → q (reviewers: ${who})`,
    );
    const body = drive
      .consolidated(store, c, String(findings.length))
      .replace(/^## Findings\n[\s\S]*?\n\n/m, `## Findings\n${lines.join('\n')}\n\n`);
    drive.add(store, c, `round-${n}/consolidated.md`, body);
    drive.go(store, c, 'complete');
  }
  function rebuild(c: drive.Ctx, answers: string): void {
    drive.go(store, c, 'start');
    commitFile(c.wt, 'src/r2.ts', '// r2\n', 'r2');
    drive.verify(store, c);
    drive.add(
      store,
      c,
      'build.md',
      `${fixture('build.md')}\n## Findings addressed\n\n${answers}\n`,
      true,
    );
    drive.go(store, c, 'complete');
  }

  it('reports reviewer, challenger, and builder rows per model with findings and escapes', async () => {
    // A (default pools): security's 1.1 fixed and passed next round; correctness's 1.2 declined
    // and then approved over; a CI repair after the passing round 2.
    const a = drive.start(store, repo.clone);
    drive.toReview(store, a);
    round(a, ['security'], ['security', 'correctness']);
    rebuild(a, '- 1.1: fixed\n- 1.2: declined — out of scope');
    drive.simplify(store, a);
    drive.passRound(store, a);
    drive.approve(store, a);
    // The event a CI rework writes (core/workflow.ts), after round 2: reaching ci needs a gh shim.
    appendEvent(
      store.db,
      a.id,
      'job.reworked',
      { from: 'ci', reason: 'test failed', ciRepairs: 0 },
      null,
      new Date().toISOString(),
    );
    store.db.update(jobs).set({ ciRepairs: 1 }).where(eq(jobs.id, a.id)).run();
    store.db
      .update(reviews)
      .set({ createdAt: at(0), completedAt: at(10 * MIN) })
      .where(and(eq(reviews.jobId, a.id), eq(reviews.reviewer, 'security')))
      .run();
    insertUsage(store, {
      ref: 'r-a',
      jobId: a.id,
      source: 'backfill',
      hours: [{ hour: T0, input: 100, output: 20, cacheRead: 5, cacheCreation: 3 }],
    });

    // B (legacy: no draw): code-quality's fixed 1.1 has no next round yet; correctness's 1.2 is
    // declined on an active job. A bug ticket names B.
    const b = drive.start(store, repo.clone);
    store.db
      .delete(events)
      .where(and(eq(events.jobId, b.id), eq(events.type, 'models.drawn')))
      .run();
    drive.toReview(store, b);
    round(b, ['code-quality'], ['code-quality', 'correctness']);
    rebuild(b, '- 1.1: fixed\n- 1.2: declined — not a defect');
    createTicket(store, {
      title: 'Export breaks',
      type: 'bug',
      body: `After ${b.id}.`,
      repo: 'r',
      repoPath: '/r',
    });

    // C (security on sonnet): correctness's 1.1 never answered, the job escalated and cancelled.
    // A revert ticket names C's PR.
    config({ security: 'sonnet' });
    const c = drive.start(store, repo.clone);
    config({});
    drive.toReview(store, c);
    round(c, ['correctness'], ['correctness']);
    drive.go(store, c, 'escalate', 'stuck');
    cancelJob(store, c.id, { session: drive.SESSION, reason: 'dropped' });
    store.db
      .update(jobs)
      .set({ prUrl: 'https://github.com/acme/alpha/pull/7' })
      .where(eq(jobs.id, c.id))
      .run();
    createTicket(store, {
      title: 'Revert CSV export',
      type: 'chore',
      body: 'Undo https://github.com/acme/alpha/pull/7',
      repo: 'r',
      repoPath: '/r',
    });

    const view = await json<AgentsView>('/api/agents');
    const zero = {
      onlyObjector: 0,
      realCatches: 0,
      fixed: 0,
      unresolved: 0,
      falseAlarms: { total: 0, declined: 0, overruled: 0, vanished: 0 },
      escapes: { total: 0, ciRepair: 0, bug: 0, revert: 0 },
      medianMs: null,
    };
    const esc = (ciRepair: number, bug: number, revert: number) => ({
      total: Math.max(ciRepair, bug, revert),
      ciRepair,
      bug,
      revert,
    });
    const fa = (declined: number, overruled: number, vanished: number) => ({
      total: declined + overruled + vanished,
      declined,
      overruled,
      vanished,
    });
    const row = (
      role: string,
      model: string | null,
      same: boolean | null,
      n: number,
      x: number,
    ) => ({
      role,
      model,
      sameAsAuthor: same,
      fellBack: false,
      reviews: n,
      objections: x,
      objectionRate: x / n,
    });
    expect(view.byModel.reviewers).toEqual([
      { ...row('security', null, null, 1, 0), ...zero, escapes: esc(0, 1, 0) },
      {
        ...row('security', 'opus', true, 2, 1),
        ...zero,
        onlyObjector: 1,
        realCatches: 1,
        escapes: esc(1, 0, 0),
        medianMs: 10 * MIN,
      },
      { ...row('security', 'sonnet', false, 1, 0), ...zero, escapes: esc(0, 0, 1) },
      {
        ...row('correctness', null, null, 1, 0),
        ...zero,
        falseAlarms: fa(1, 0, 0),
        escapes: esc(0, 1, 0),
      },
      {
        ...row('correctness', 'sonnet', false, 3, 1),
        ...zero,
        onlyObjector: 1,
        falseAlarms: fa(0, 1, 1),
        escapes: esc(1, 0, 0),
      },
      { ...row('code-quality', null, null, 1, 1), ...zero, onlyObjector: 1, unresolved: 1 },
      {
        ...row('code-quality', 'sonnet', false, 3, 0),
        ...zero,
        escapes: { total: 2, ciRepair: 1, bug: 0, revert: 1 },
      },
    ]);
    expect(view.byModel.challengers).toEqual([
      row('spec-challenger', null, null, 1, 0),
      row('spec-challenger', 'sonnet', false, 2, 0),
    ]);
    const builder = (model: string | null, over: Record<string, unknown>) => ({
      role: 'builder',
      model,
      sameAsAuthor: null,
      fellBack: false,
      firstPassRate: 1,
      ...over,
    });
    expect(view.byModel.builders.filter((r) => r.role === 'builder')).toEqual([
      builder(null, {
        jobs: 1,
        meanRounds: 1,
        meanCiRepairs: 0,
        escalationsPerJob: 0,
        tokenJobs: 0,
        meanTokens: null,
      }),
      builder('opus', {
        jobs: 2,
        meanRounds: 1.5,
        meanCiRepairs: 0.5,
        escalationsPerJob: 0.5,
        tokenJobs: 1,
        meanTokens: 128,
      }),
    ]);
    expect(
      view.byModel.builders.filter((r) => r.role === 'spec-writer').map((r) => r.jobs),
    ).toEqual([1, 2]);
    expect(
      view.byModel.authorTotals.find((r) => r.role === 'security' && r.sameAsAuthor === false),
    ).toEqual({
      role: 'security',
      sameAsAuthor: false,
      reviews: 1,
      objections: 0,
      objectionRate: 0,
    });
    expect(view.notes.map((n) => n.text)).toContain(
      'security on opus: 1 objections in 2 reviews; not enough data.',
    );
    expect(view.notes.find((n) => n.text.startsWith('builder on opus'))).toEqual({
      role: 'builder',
      text: 'builder on opus: 2 jobs; not enough data.',
      n: 2,
      confidence: 'low',
    });
    // Legacy rows never appear in a note.
    expect(view.notes.some((n) => n.text.includes('null'))).toBe(false);
  });
});

describe('GET /api/health', () => {
  // The range ends with the hour holding NOW: bucket 22 is T0's hour, bucket 23 the next, partial one.
  const NOW = T0 + 90 * MIN;
  const ev = (job: string, type: string, min: number, payload: Record<string, unknown> = {}) =>
    appendEvent(store.db, job, type, payload, null, at(min * MIN));
  const hours = (v: HealthView, id: string) => v.buckets.slice(21).map((b) => b.values[id]);

  it('serves one value per series per bucket and refuses other ranges (AC1, AC2)', async () => {
    for (const q of ['hours=5', 'hours=abc', '']) {
      const res = await get(`/api/health?${q}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { type: 'UsageError', message: 'hours must be one of 24, 168, or 720' },
      });
    }
    const before = Date.now();
    const v = await json<HealthView>('/api/health?hours=24');
    expect(v.hours).toBe(24);
    expect(v.buckets).toHaveLength(24);
    const last = Date.parse(v.buckets.at(-1)?.hour ?? '');
    expect([rangeOf(24, before).last, rangeOf(24, Date.now()).last]).toContain(last);
    expect(Date.parse(v.buckets[0]?.hour ?? '')).toBe(last - 23 * HOUR);
    const ids = v.series.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of v.buckets) expect(Object.keys(b.values)).toEqual(ids);
    expect(Object.keys(v.total)).toEqual(ids);
    // Groups in table order, and no controller stop series on an empty store.
    expect([...new Set(v.series.map((s) => s.group))]).toEqual([
      'errors',
      'reviewers',
      'throughput',
    ]);
    expect(ids.some((id) => id.startsWith('stop.'))).toBe(false);
    expect(ids.slice(0, 2)).toEqual(['failed.spec', 'failed.build']);
    expect(ids).not.toContain('failed.needs-human');
    for (const s of v.series) expect(v.total[s.id]).toBe(s.unit === 'count' ? 0 : null);
    expect((await json<HealthView>('/api/health?hours=168')).buckets).toHaveLength(168);
    expect(health(store, '720', NOW).buckets).toHaveLength(720);
  });

  it('counts events and rows in the UTC hour of their time (AC3 to AC8, AC12)', () => {
    const a = seedJob({
      status: 'completed',
      round: 1,
      createdAt: at(-30 * MIN),
      completedAt: at(10 * MIN),
    }); // 40 min, first hour
    seedJob({ status: 'completed', round: 3, createdAt: at(0), completedAt: at(20 * MIN) }); // 20 min
    const byEvent = seedJob({ status: 'completed', round: 5, createdAt: at(0) });
    ev(byEvent, 'job.completed', 70); // 70 min, second hour
    seedJob({ status: 'cancelled', round: 9, createdAt: at(0), completedAt: at(-23 * HOUR) }); // too old

    ev(a, 'stage.failed', -22 * 60 - 1, { stage: 'build' }); // one minute before the first bucket
    ev(a, 'stage.failed', 5, { stage: 'build' });
    ev(a, 'stage.failed', 65, { stage: 'build' });
    ev(a, 'stage.failed', 65, { stage: 'bogus' }); // not a stage: no series
    ev(a, 'job.blocked', 6, { from: 'review', reason: MAX_ROUNDS_REASON });
    ev(a, 'job.blocked', 66, { from: 'ci', reason: 'CI went away' });
    ev(a, 'job.blocked', 67, { from: 'build' });
    ev(a, 'runner.stopped', 7, { code: 'no-progress' });
    ev(a, 'runner.stopped', 68, { code: 'merge-blocked' });
    ev(a, 'pr.merged', 8, { ok: false, error: 'refused' });
    ev(a, 'pr.merged', 69, { ok: true, mergeCommit: 'abc', verified: true, ticketId: 't1' });
    ev(a, 'pr.merged', 69, { ok: true, mergeCommit: 'abd', verified: true, ticketId: null });
    ev(a, 'job.reworked', 9, { from: 'ci' });
    ev(a, 'job.reworked', 70, { from: 'ci', integration: true });
    ev(a, 'verification.completed', 11, { status: 'failed' });
    ev(a, 'verification.completed', 11, { status: 'passed' });
    ev(a, 'ci.observed', 12, { outcome: 'failing' });
    ev(a, 'ci.observed', 13); // a `pr status` observation: no outcome

    const ci = seedJob({ createdAt: at(0) });
    ev(ci, 'stage.started', 10, { stage: 'ci' });
    ev(ci, 'stage.completed', 20, { stage: 'ci' }); // 10 min, first hour
    ev(ci, 'stage.started', 30, { stage: 'ci' });
    ev(ci, 'stage.failed', 62, { stage: 'ci' }); // 32 min, second hour
    ev(ci, 'stage.started', 63, { stage: 'ci' }); // still open

    const review = (round: number, verdict: 'pass' | 'changes' | null, done?: number) => ({
      jobId: a,
      round,
      reviewer: 'security',
      verdict,
      createdAt: at(0),
      completedAt: done === undefined ? null : at(done * MIN),
    });
    store.db
      .insert(reviews)
      .values([review(1, 'pass', 15), review(2, 'changes', 75), review(3, null)])
      .run();
    store.db
      .insert(artifacts)
      .values({
        jobId: a,
        stage: 'spec',
        round: null,
        path: 'spec-review-1.md',
        bytes: 1,
        marker: 'CHANGES',
        createdAt: at(16 * MIN),
      })
      .run();

    const before = listJobs(store.db);
    const v = health(store, '24', NOW);
    expect(listJobs(store.db)).toEqual(before);
    expect(v.buckets.slice(21).map((b) => b.hour)).toEqual([at(-HOUR), at(0), at(HOUR)]);
    const expected: Record<string, [(number | null)[], number | null]> = {
      // errors; the event before the range is in no bucket and not in the total (d)
      'failed.build': [[0, 1, 1], 2],
      'failed.ci': [[0, 0, 1], 1],
      'blocked.from.review': [[0, 1, 0], 1],
      'blocked.from.ci': [[0, 0, 1], 1],
      'blocked.reason.max-rounds': [[0, 1, 0], 1],
      'blocked.reason.other': [[0, 0, 2], 2],
      'blocked.reason.scope-gap': [[0, 0, 0], 0],
      'verification.failed': [[0, 1, 0], 1],
      'ci.failed': [[0, 1, 0], 1],
      'ci.repair': [[0, 1, 0], 1],
      'merge.failed': [[0, 1, 0], 1],
      'merge.stopped': [[0, 0, 1], 1],
      'stop.no-progress': [[0, 1, 0], 1],
      'stop.merge-blocked': [[0, 0, 1], 1],
      // reviewers; the cancelled job finished before the range
      'review.runs.security': [[0, 1, 1], 2],
      'review.changes.security': [[0, 0, 1], 1],
      'review.runs.correctness': [[0, 0, 0], 0],
      'spec-challenge.runs': [[0, 1, 0], 1],
      'spec-challenge.changes': [[0, 1, 0], 1],
      'review.rounds': [[null, 2, 5], 3],
      'rework.from.ci': [[0, 1, 1], 2],
      'rework.from.approve': [[0, 0, 0], 0],
      // throughput: medians per hour, null when empty, and over every span in the total
      'tickets.merged': [[0, 0, 1], 1],
      'jobs.completed': [[0, 2, 1], 3],
      'jobs.duration': [[null, 30 * MIN, 70 * MIN], 40 * MIN],
      'ci.visits': [[0, 1, 1], 2],
      'ci.wait': [[null, 10 * MIN, 32 * MIN], 21 * MIN],
    };
    for (const [id, [perHour, total]] of Object.entries(expected)) {
      expect([id, hours(v, id), v.total[id]]).toEqual([id, perHour, total]);
    }
    // Nothing happened in the 21 hours before.
    for (const b of v.buckets.slice(0, 21)) {
      for (const s of v.series) expect(b.values[s.id]).toBe(s.unit === 'count' ? 0 : null);
    }
    // Stop codes seen in the range follow the fixed error series, sorted by code.
    const ids = v.series.map((s) => s.id);
    const i = ids.indexOf('merge.stopped');
    expect(ids.slice(i, i + 4)).toEqual([
      'merge.stopped',
      'stop.merge-blocked',
      'stop.no-progress',
      'review.runs.security',
    ]);
    expect(v.series.find((s) => s.id === 'stop.no-progress')).toEqual({
      id: 'stop.no-progress',
      label: 'Controller stop: no-progress',
      group: 'errors',
      unit: 'count',
    });
    expect(ids).not.toContain('failed.bogus');
  });
});
