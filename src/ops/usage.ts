/**
 * Usage report for a job: what the recorded events, reviews, and verification runs measure
 * about where the job's time went. Wall-clock per stage visit and per reviewer run, the models
 * the plan assigned, verification time, CI repairs and re-runs. Token counts and money are not
 * measured anywhere `orch` can read them, and the report says so instead of estimating.
 */
import { resolveRoles } from '../core/roles.ts';
import type { Stage } from '../core/workflow.ts';
import type { Store } from '../storage/client.ts';
import { listEvents } from '../storage/events.ts';
import { getJob, listReviews } from '../storage/jobs.ts';
import type { Event } from '../storage/schema.ts';
import { listChecks, listRuns } from '../storage/verification.ts';
import { loadConfig } from './factory.ts';

export interface StageVisit {
  stage: Stage;
  /** Review round in effect during the visit (0 before the first review). */
  round: number;
  startedAt: string;
  /** Null while the visit is still open (the stage is running or was abandoned). */
  endedAt: string | null;
  /** How the visit ended: stage.completed, stage.failed, job.blocked, job.reworked, ... */
  endedBy: string | null;
  durationMs: number | null;
}

export interface ReviewerRun {
  round: number;
  reviewer: string;
  /** Model the configuration assigns to the role; the model that actually ran is not recorded. */
  configuredModel: string | null;
  verdict: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface UsageReport {
  jobId: string;
  /** From job creation to completion, or to now while unfinished. */
  wallMs: number;
  stages: StageVisit[];
  /** Closed-visit time per stage. */
  stageMs: Partial<Record<Stage, number>>;
  reviews: ReviewerRun[];
  reviewMs: number;
  verification: { runs: number; checks: number; totalMs: number };
  ci: { repairs: number; reruns: number; observations: number };
  /** What is not measured, stated rather than estimated. */
  tokens: { measured: false; reason: string };
  /** Role to configured model, for reading the durations as cost drivers. */
  models: Record<string, string>;
}

/** Events that close a stage visit. */
const ENDS = new Set([
  'stage.completed',
  'stage.failed',
  'job.blocked',
  'job.reworked',
  'job.cancelled',
  'job.interrupted',
]);

const ms = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));

function visits(events: Event[]): StageVisit[] {
  const out: StageVisit[] = [];
  let round = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    if (e.type === 'stage.completed' && e.payload['stage'] === 'build') round += 1;
    if (e.type !== 'stage.started') continue;
    const end = events.slice(i + 1).find((x) => ENDS.has(x.type));
    out.push({
      stage: e.payload['stage'] as Stage,
      round,
      startedAt: e.createdAt,
      endedAt: end?.createdAt ?? null,
      endedBy: end?.type ?? null,
      durationMs: end ? ms(e.createdAt, end.createdAt) : null,
    });
  }
  return out;
}

export function jobUsage(store: Store, id: string): UsageReport {
  const job = getJob(store.db, id);
  const events = listEvents(store.db, id, 10_000);
  const roles = resolveRoles(loadConfig(store));
  const models = Object.fromEntries(roles.map((r) => [r.name, r.model]));
  const stages = visits(events);
  const stageMs: Partial<Record<Stage, number>> = {};
  for (const v of stages) {
    if (v.durationMs !== null) stageMs[v.stage] = (stageMs[v.stage] ?? 0) + v.durationMs;
  }
  const reviews: ReviewerRun[] = listReviews(store.db, id).map((r) => ({
    round: r.round,
    reviewer: r.reviewer,
    configuredModel: models[r.reviewer] ?? null,
    verdict: r.verdict,
    startedAt: r.createdAt,
    completedAt: r.completedAt,
    durationMs: r.completedAt ? ms(r.createdAt, r.completedAt) : null,
  }));
  const runs = listRuns(store.db, id);
  let checks = 0;
  let totalMs = 0;
  for (const run of runs) {
    for (const c of listChecks(store.db, run.id)) {
      checks += 1;
      totalMs += c.durationMs ?? 0;
    }
  }
  return {
    jobId: id,
    wallMs: ms(job.createdAt, job.completedAt ?? new Date().toISOString()),
    stages,
    stageMs,
    reviews,
    reviewMs: reviews.reduce((a, r) => a + (r.durationMs ?? 0), 0),
    verification: { runs: runs.length, checks, totalMs },
    ci: {
      repairs: job.ciRepairs,
      reruns: events.filter((e) => e.type === 'ci.rerun' && e.payload['ok'] === true).length,
      observations: events.filter((e) => e.type === 'ci.observed').length,
    },
    tokens: {
      measured: false,
      reason:
        'Claude Code does not expose subagent token counts or cost to the coordinating session or ' +
        'to orch through a supported interface; durations and configured models are the measured ' +
        'cost drivers. See docs/decisions.md #61.',
    },
    models,
  };
}
