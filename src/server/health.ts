/**
 * The health read model: errors and stops, reviewer effectiveness, and throughput per UTC hour,
 * in the buckets of `/api/usage`. Every value is derived from events and rows orch already
 * records. Display only: nothing here writes, and nothing may decide from these counts.
 */
import { SPEC_REVIEW_PATH } from '../core/artifact-rules.ts';
import { UsageError } from '../core/errors.ts';
import { ROLES } from '../core/roles.ts';
import {
  MAX_CI_REPAIRS_REASON,
  MAX_ROUNDS_REASON,
  MERGE_BLOCKS,
  SCOPE_GAP_REASON,
  STAGES,
} from '../core/workflow.ts';
import { ENDS, visits } from '../ops/usage.ts';
import { artifactsByJob } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { eventsByJob } from '../storage/events.ts';
import { listJobs, reviewsByJob } from '../storage/jobs.ts';
import type { Event } from '../storage/schema.ts';
import { median, span, terminalAt } from './api.ts';
import { HOUR_MS, rangeOf, USAGE_RANGES } from './token-usage.ts';
import type { HealthSeries, HealthView } from './types.ts';

const WORK_STAGES = STAGES.filter((s) => s !== 'needs-human' && s !== 'completed');
const REVIEWERS = ROLES.filter((r) => r.kind === 'review').map((r) => r.name);
const REWORK_FROM = ['approve', 'pr', 'ci'];

const REASON_CODE = new Map([
  [MAX_ROUNDS_REASON, 'max-rounds'],
  [MAX_CI_REPAIRS_REASON, 'max-ci-repairs'],
  [SCOPE_GAP_REASON, 'scope-gap'],
]);

/** The controller's merge refusals: `MERGE_BLOCKS`, plus the two codes only `ops/run.ts` emits. */
const MERGE_STOPS = new Set<string>([...MERGE_BLOCKS, 'merge-no-answer', 'merge-blocked']);

/** `job.completed` is what `terminalAt` falls back to; the rest are the series' sources. */
const TYPES = [
  'stage.started',
  ...ENDS,
  'job.completed',
  'verification.completed',
  'ci.observed',
  'pr.merged',
  'runner.stopped',
];

type Group = HealthSeries['group'];
const one = (
  id: string,
  label: string,
  group: Group,
  unit: HealthSeries['unit'] = 'count',
): HealthSeries => ({ id, label, group, unit });

/** Every series but `stop.<code>`, in the order of the view; `stops` go last in `errors`. */
function seriesOf(stops: readonly string[]): HealthSeries[] {
  return [
    ...WORK_STAGES.map((s) => one(`failed.${s}`, `Failed: ${s}`, 'errors')),
    ...WORK_STAGES.map((s) => one(`blocked.from.${s}`, `Escalated from ${s}`, 'errors')),
    one('blocked.reason.max-rounds', 'Escalated: review-round budget', 'errors'),
    one('blocked.reason.max-ci-repairs', 'Escalated: CI-repair budget', 'errors'),
    one('blocked.reason.scope-gap', 'Escalated: scope gap', 'errors'),
    one('blocked.reason.other', 'Escalated: other', 'errors'),
    one('verification.failed', 'Verification failed', 'errors'),
    one('ci.failed', 'CI failed', 'errors'),
    one('ci.repair', 'CI repair', 'errors'),
    one('merge.failed', 'Merge call failed', 'errors'),
    one('merge.stopped', 'Merge refused (controller)', 'errors'),
    ...stops.map((id) => one(id, `Controller stop: ${id.slice('stop.'.length)}`, 'errors')),
    ...REVIEWERS.map((r) => one(`review.runs.${r}`, `Reviews: ${r}`, 'reviewers')),
    ...REVIEWERS.map((r) => one(`review.changes.${r}`, `CHANGES: ${r}`, 'reviewers')),
    one('spec-challenge.runs', 'Spec challenges', 'reviewers'),
    one('spec-challenge.changes', 'Spec challenge CHANGES', 'reviewers'),
    one('review.rounds', 'Review rounds per finished job', 'reviewers', 'rounds'),
    ...REWORK_FROM.map((s) => one(`rework.from.${s}`, `Sent back from ${s}`, 'reviewers')),
    one('tickets.merged', 'Tickets merged', 'throughput'),
    one('jobs.completed', 'Jobs completed', 'throughput'),
    one('jobs.duration', 'Job duration (median)', 'throughput', 'ms'),
    one('ci.visits', 'CI waits ended', 'throughput'),
    one('ci.wait', 'Time waiting on CI (median)', 'throughput', 'ms'),
  ];
}

/** Health series per UTC hour over the last `hours` (24, 168, or 720) of every job, archived included. */
export function health(store: Store, hours: string | null, at = Date.now()): HealthView {
  const range = USAGE_RANGES.find((r) => String(r) === hours);
  if (range === undefined) throw new UsageError('hours must be one of 24, 168, or 720');
  const { first } = rangeOf(range, at);

  // Series id -> the samples of each bucket: a count series counts them, a median series takes
  // their median. An id that is in no series (an unknown stage or reviewer) is never read.
  const samples = new Map<string, number[][]>();
  const hit = (id: string, when: string | null, value = 1) => {
    const i = when === null ? NaN : Math.floor(Date.parse(when) / HOUR_MS) - first / HOUR_MS;
    if (!(i >= 0 && i < range)) return;
    let s = samples.get(id);
    if (!s) samples.set(id, (s = Array.from({ length: range }, () => [])));
    s[i]?.push(value);
  };

  const jobs = listJobs(store.db);
  const ids = jobs.map((j) => j.id);
  const eventsOf = eventsByJob(store.db, ids, TYPES);

  for (const job of jobs) {
    const events = eventsOf.get(job.id) ?? [];
    const str = (e: Event, key: string) => String(e.payload[key]);
    for (const e of events) {
      const p = e.payload;
      const t = e.createdAt;
      if (e.type === 'stage.failed') hit(`failed.${str(e, 'stage')}`, t);
      else if (e.type === 'job.blocked') {
        hit(`blocked.from.${str(e, 'from')}`, t);
        hit(`blocked.reason.${REASON_CODE.get(str(e, 'reason')) ?? 'other'}`, t);
      } else if (e.type === 'verification.completed') {
        if (p['status'] === 'failed') hit('verification.failed', t);
      } else if (e.type === 'ci.observed') {
        if (p['outcome'] === 'failing') hit('ci.failed', t);
      } else if (e.type === 'job.reworked') {
        hit(`rework.from.${str(e, 'from')}`, t);
        if (p['from'] === 'ci' && p['integration'] !== true) hit('ci.repair', t);
      } else if (e.type === 'pr.merged') {
        if (p['ok'] === false) hit('merge.failed', t);
        // The event `recordMerge` writes for a verified merge of a ticket's job.
        const merged = p['ok'] === true && typeof p['mergeCommit'] === 'string';
        if (merged && p['verified'] === true && (p['ticketId'] ?? null) !== null)
          hit('tickets.merged', t);
      } else if (e.type === 'runner.stopped' && typeof p['code'] === 'string') {
        hit(`stop.${p['code']}`, t);
        if (MERGE_STOPS.has(p['code'])) hit('merge.stopped', t);
      }
    }
    for (const v of visits(events)) {
      if (v.stage !== 'ci' || v.endedAt === null) continue;
      hit('ci.visits', v.endedAt);
      if (v.durationMs !== null) hit('ci.wait', v.endedAt, v.durationMs);
    }
    if (job.status === 'completed' || job.status === 'cancelled') {
      const end = terminalAt(job, new Map(events.map((e) => [e.type, e])));
      hit('review.rounds', end, job.round);
      if (job.status === 'completed') {
        hit('jobs.completed', end);
        const ms = span(job.createdAt, end);
        if (ms !== null) hit('jobs.duration', end, ms);
      }
    }
  }
  for (const r of [...reviewsByJob(store.db, ids).values()].flat()) {
    if (r.verdict === null || r.completedAt === null) continue;
    hit(`review.runs.${r.reviewer}`, r.completedAt);
    if (r.verdict === 'changes') hit(`review.changes.${r.reviewer}`, r.completedAt);
  }
  for (const a of [...artifactsByJob(store.db, ids).values()].flat()) {
    if (!SPEC_REVIEW_PATH.test(a.path) || a.marker === null) continue;
    hit('spec-challenge.runs', a.createdAt);
    if (a.marker.toLowerCase() === 'changes') hit('spec-challenge.changes', a.createdAt);
  }

  const series = seriesOf([...samples.keys()].filter((id) => id.startsWith('stop.')).sort());
  const valueOf = (s: HealthSeries, xs: readonly number[]) =>
    s.unit === 'count' ? xs.length : median(xs);
  return {
    hours: range,
    buckets: Array.from({ length: range }, (_, i) => ({
      hour: new Date(first + i * HOUR_MS).toISOString(),
      values: Object.fromEntries(
        series.map((s) => [s.id, valueOf(s, samples.get(s.id)?.[i] ?? [])]),
      ),
    })),
    series,
    total: Object.fromEntries(
      series.map((s) => [s.id, valueOf(s, (samples.get(s.id) ?? []).flat())]),
    ),
  };
}
