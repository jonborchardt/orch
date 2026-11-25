/**
 * Dashboard read models and action dispatch. Reads go through storage and ops; writes go through
 * ops/actions.ts (which uses the same validated transitions as the CLI). No SQL here.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { SPEC_REVIEW_PATH } from '../core/artifact-rules.ts';
import { UsageError, ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import { claudeHome, jobArtifactDir } from '../core/paths.ts';
import { ROLES, type RoleKind } from '../core/roles.ts';
import { SESSION_EVENT, sessionLinks, UUID } from '../core/session.ts';
import {
  cannotRefreshPr,
  type JobMode,
  now,
  prPhase,
  STAGES,
  type Stage,
  TERMINAL_STATUSES,
} from '../core/workflow.ts';
import {
  afterAction,
  allowedActions,
  CHOICE_ACTIONS,
  currentChoices,
  DASHBOARD_ACTIONS,
  type DashboardAction,
  dashboardAction,
  withoutToken,
} from '../ops/actions.ts';
import { planJob } from '../ops/factory.ts';
import { gradedReadiness } from '../ops/init.ts';
import { mergeView } from '../ops/merge-view.ts';
import { storedUsage } from '../ops/token-usage.ts';
import { ENDS, visits } from '../ops/usage.ts';
import { currentFlakes } from '../ops/verify.ts';
import { baseConflicts } from '../ops/worktree.ts';
import { artifactsByJob, listArtifacts } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { eventsByJob, eventsOfTypes, latestEventsByJob, listEvents } from '../storage/events.ts';
import {
  getJob,
  listJobs,
  listReviews,
  predecessorsOf,
  reviewsByJob,
  sessionOf,
} from '../storage/jobs.ts';
import type { Artifact, Event, Job, Review } from '../storage/schema.ts';
import { latestRun, latestRunsByJob, runDetail } from '../storage/verification.ts';
import {
  BLOCKER_EVENTS,
  blockerOf,
  ciView,
  liveness,
  outcomeOf,
  progressOf,
  resumeOf,
  TIMELINE_EVENTS,
  timelineOf,
} from './status.ts';
import { readTokenUsage, spanEnd, USAGE_RANGES } from './token-usage.ts';
import { readSessionLog } from './transcript.ts';
import type {
  ActionRequest,
  ActionResponse,
  AgentsView,
  AgentTiming,
  BoardRow,
  ClaudeSession,
  JobDetailView,
  ReadinessView,
  RoundView,
  RunsView,
  SafeJob,
  SessionLogView,
  SessionView,
  StageRow,
  UsageView,
} from './types.ts';

export const JOB_ID = /^job-[0-9a-f]{8}$/;
/** Artifact contents above this size are omitted from the detail view (fetch them individually). */
const INLINE_LIMIT = 512 * 1024;

export function safeJob(job: Job): SafeJob {
  return withoutToken(job);
}

function blockingOf(artifacts: Artifact[], round: number): number | null {
  const a = artifacts.find((x) => x.path === `round-${String(round)}/consolidated.md`);
  if (!a?.marker) return null;
  const n = Number(a.marker);
  return Number.isInteger(n) ? n : null;
}

export function board(store: Store, filter: { repo?: string | undefined } = {}): BoardRow[] {
  const ts = now();
  const jobs = listJobs(store.db, { repo: filter.repo });
  const ids = jobs.map((j) => j.id);
  // Five queries for the whole board rather than several per job: it is polled every few seconds.
  const reviewsOf = reviewsByJob(store.db, ids);
  const artifactsOf = artifactsByJob(store.db, ids);
  const eventsOf = latestEventsByJob(store.db, ids, BLOCKER_EVENTS);
  const flakes = currentFlakes(store);
  const runsOf = latestRunsByJob(store.db, ids);
  // Supersession stays within one repository, so the filtered list already holds both ends.
  const predecessors = new Map<string, string[]>();
  for (const j of jobs) {
    if (j.supersededBy) {
      predecessors.set(j.supersededBy, [...(predecessors.get(j.supersededBy) ?? []), j.id]);
    }
  }
  return jobs.map((job) => {
    const reviews = (reviewsOf.get(job.id) ?? []).filter((r) => r.round === job.round);
    const artifacts = artifactsOf.get(job.id) ?? [];
    const state = liveness(job);
    const evidence = {
      events: eventsOf.get(job.id) ?? new Map<string, Event>(),
      artifacts,
      latestRun: runsOf.get(job.id) ?? null,
    };
    const owner = job.ownerSession
      ? {
          session: job.ownerSession,
          leaseExpiresAt: job.leaseExpiresAt,
          live: !leaseExpired(job, ts),
        }
      : null;
    const end = TERMINAL_STATUSES.includes(job.status) ? terminalAt(job, evidence.events) : ts;
    // The board does not inspect worktrees (one Git call per job); the detail view does.
    const ci = ciView(job, evidence.events, undefined);
    return {
      id: job.id,
      title: job.title,
      repo: job.repo,
      repoPath: job.repoPath,
      stage: job.stage,
      status: job.status,
      mode: job.mode,
      liveness: state,
      outcome: outcomeOf(state, job, ci.completion),
      round: job.round,
      maxRounds: job.maxRounds,
      owner,
      worktreePath: job.worktreePath,
      branch: job.branch,
      reviews: reviews.map((r) => ({ reviewer: r.reviewer, verdict: r.verdict })),
      // Current round only: a re-review must not wear the previous round's blocking chip.
      blocking: blockingOf(artifacts, job.round),
      blocker: blockerOf(job, state, evidence),
      resume: resumeOf(job, state),
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      elapsedMs: span(job.createdAt, end),
      pr: {
        url: job.prUrl,
        state: job.prState,
        phase: prPhase(job, ci.completion),
        refreshable: cannotRefreshPr(job) === null,
      },
      supersededBy: job.supersededBy,
      ticketId: job.ticketId,
      archivedAt: job.archivedAt,
      supersedes: predecessors.get(job.id) ?? [],
      ci,
      progress: progressOf(job, evidence.events),
      flake: flakes.get(job.id) ?? null,
    };
  });
}

/** When a finished job finished: `completedAt`, else its newest terminal event, never the poll time. */
function terminalAt(job: Job, events: Map<string, Event>): string | null {
  if (job.completedAt) return job.completedAt;
  const times = ['job.completed', 'job.cancelled'].flatMap((t) => events.get(t)?.createdAt ?? []);
  return times.sort().at(-1) ?? null;
}

/** Wall-clock milliseconds, or null when the end is unknown or the span is unparseable or negative. */
function span(from: string, to: string | null): number | null {
  const ms = to === null ? NaN : Date.parse(to) - Date.parse(from);
  return Number.isNaN(ms) || ms < 0 ? null : ms;
}

/** Median of the values, or null for none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

const average = (xs: readonly number[]) =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Durations of finished runs; only intervals above zero are measured. */
export function timing(xs: readonly (number | null)[]): AgentTiming {
  const measured = xs.flatMap((ms) => (ms !== null && ms > 0 ? [ms] : []));
  return {
    unmeasured: xs.length - measured.length,
    averageMs: average(measured),
    medianMs: median(measured),
  };
}

/** The Runs section: counts and durations over every job, from persisted rows and events. */
export function runs(store: Store): RunsView {
  const jobs = listJobs(store.db);
  const eventsOf = latestEventsByJob(
    store.db,
    jobs.map((j) => j.id),
    ['job.completed', 'job.cancelled'],
  );
  const completed = jobs.filter((j) => j.status === 'completed');
  const cancelled = jobs.filter((j) => j.status === 'cancelled').length;
  const durations: number[] = [];
  let lastFinish = -Infinity;
  for (const j of completed) {
    const end = terminalAt(j, eventsOf.get(j.id) ?? new Map<string, Event>());
    const d = span(j.createdAt, end);
    if (d !== null) durations.push(d);
    const t = end === null ? NaN : Date.parse(end);
    if (!Number.isNaN(t)) lastFinish = Math.max(lastFinish, t);
  }
  const firstCreated = Math.min(...jobs.map((j) => Date.parse(j.createdAt)));
  const hours = (lastFinish - firstCreated) / 3_600_000;
  const finished = completed.length + cancelled;
  return {
    total: jobs.length,
    completed: completed.length,
    cancelled,
    active: jobs.length - finished,
    completionRate: finished === 0 ? null : completed.length / finished,
    durationMs: { average: average(durations), median: median(durations) },
    durationUnknown: completed.length - durations.length,
    completedPerHour:
      completed.length > 0 && Number.isFinite(hours) && hours > 0 ? completed.length / hours : null,
  };
}

/** Roles measured by their stage's visits; the builder pair is split by `jobs.mode`. */
const STAGE_OF: Record<
  Exclude<RoleKind, 'review' | 'spec-challenge'>,
  { stage: Stage; mode?: JobMode }
> = {
  spec: { stage: 'spec' },
  build: { stage: 'build', mode: 'full' },
  'fast-build': { stage: 'build', mode: 'fast' },
  simplify: { stage: 'simplify' },
  approve: { stage: 'approve' },
};

/** The Stages column each end event (`ENDS` in ops/usage.ts) counts in. */
const STAGE_COLUMN: Record<string, keyof Omit<StageRow, 'role' | 'runs' | keyof AgentTiming>> = {
  'stage.completed': 'completed',
  'stage.failed': 'failed',
  'job.blocked': 'escalated',
  'job.reworked': 'sentBack',
  'job.cancelled': 'cancelled',
  'job.interrupted': 'interrupted',
};

function reviewerRow(role: string, verdicts: { verdict: string; ms: number | null }[]) {
  const count = (v: string) => verdicts.filter((x) => x.verdict === v).length;
  return {
    role,
    runs: verdicts.length,
    pass: count('pass'),
    changes: count('changes'),
    ...timing(verdicts.map((x) => x.ms)),
  };
}

/** The Agents section: reviewers and stage roles, each in `ROLES` order; unfinished runs skipped. */
export function agents(store: Store): AgentsView {
  const jobs = listJobs(store.db);
  const ids = jobs.map((j) => j.id);
  const reviewsOf = reviewsByJob(store.db, ids);
  const eventsOf = eventsByJob(store.db, ids, ['stage.started', ...ENDS]);
  const allReviews = [...reviewsOf.values()].flat();
  // The spec challenger records no review row; its verdicts are the registered spec reviews.
  const specVerdicts = [...artifactsByJob(store.db, ids).values()]
    .flat()
    .flatMap((a) =>
      SPEC_REVIEW_PATH.test(a.path) && a.marker !== null
        ? [{ verdict: a.marker.toLowerCase(), ms: null }]
        : [],
    );
  const jobVisits = jobs.map((j) => ({ mode: j.mode, visits: visits(eventsOf.get(j.id) ?? []) }));
  const view: AgentsView = { reviewers: [], stages: [] };
  for (const role of ROLES) {
    if (role.kind === 'spec-challenge' || role.kind === 'review') {
      const xs =
        role.kind === 'spec-challenge'
          ? specVerdicts
          : allReviews.flatMap((r) =>
              r.reviewer === role.name && r.verdict !== null
                ? [{ verdict: r.verdict, ms: span(r.createdAt, r.completedAt) }]
                : [],
            );
      view.reviewers.push(reviewerRow(role.name, xs));
      continue;
    }
    const on = STAGE_OF[role.kind];
    const ended = jobVisits
      .filter((j) => on.mode === undefined || j.mode === on.mode)
      .flatMap((j) => j.visits.filter((v) => v.stage === on.stage && v.endedBy !== null));
    const row: StageRow = {
      role: role.name,
      runs: ended.length,
      completed: 0,
      failed: 0,
      escalated: 0,
      sentBack: 0,
      cancelled: 0,
      interrupted: 0,
      ...timing(ended.map((v) => v.durationMs)),
    };
    for (const v of ended) {
      const column = STAGE_COLUMN[v.endedBy ?? ''];
      if (column) row[column] += 1;
    }
    view.stages.push(row);
  }
  return view;
}

export function repos(store: Store): string[] {
  return [...new Set(listJobs(store.db).map((j) => j.repo))].sort();
}

function rounds(reviews: Review[], artifacts: Artifact[]): RoundView[] {
  const byId = new Map(artifacts.map((a) => [a.id, a.path]));
  const numbers = new Set<number>(reviews.map((r) => r.round));
  for (const a of artifacts) {
    const m = /^round-(\d+)\//.exec(a.path);
    if (m) numbers.add(Number(m[1]));
  }
  return [...numbers]
    .sort((a, b) => a - b)
    .map((round) => ({
      round,
      reviews: reviews
        .filter((r) => r.round === round)
        .map((r) => ({
          ...r,
          path: r.artifactId === null ? null : (byId.get(r.artifactId) ?? null),
        })),
      consolidated: artifacts.some((a) => a.path === `round-${String(round)}/consolidated.md`)
        ? `round-${String(round)}/consolidated.md`
        : null,
      blocking: blockingOf(artifacts, round),
    }));
}

export function assertJobId(id: string | undefined): string {
  if (!id || !JOB_ID.test(id)) throw new ValidationError(`Invalid job id: ${id ?? ''}`);
  return id;
}

/**
 * The only shapes orch writes logs under: `verification/<runId>/<checkId>.log` (ops/verify.ts) and
 * `ci/<sha7>/<name>.log` (ops/github.ts). The dashboard links only the hrefs `logLinks` builds
 * from it, so the client holds no copy of this rule.
 */
const LOG_PATH = /^(?:verification\/\d+|ci\/[0-9a-f]{7})\/[A-Za-z0-9._-]+\.log$/;

export function isLogPath(p: unknown): p is string {
  return (
    typeof p === 'string' && LOG_PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..')
  );
}

/**
 * Whether orch recorded `rel` as a log of this job: a check `outputPath` of one of its verification
 * runs, or a `failures[].log` of one of its `ci.observed` events. Payload values that are not
 * strings or not log-shaped never match.
 */
function recordedLog(store: Store, id: string, rel: string): boolean {
  if (!isLogPath(rel)) return false;
  const run = /^verification\/(\d+)\//.exec(rel);
  if (run) {
    const d = runDetail(store.db, Number(run[1]));
    return d?.run.jobId === id && d.checks.some((c) => c.outputPath === rel);
  }
  return eventsOfTypes(store.db, id, ['ci.observed']).some((e) => {
    const failures = e.payload['failures'];
    return (
      Array.isArray(failures) &&
      failures.some((f: unknown) => {
        const log = typeof f === 'object' && f !== null ? (f as { log?: unknown }).log : undefined;
        return isLogPath(log) && log === rel;
      })
    );
  });
}

/**
 * Content of a registered artifact or a log orch recorded for the job; anything else under the
 * directory is not served. The file's real path must lie inside the real artifact directory, so a
 * junction or symlink cannot lead out of it.
 */
export function artifactContent(store: Store, id: string, relPath: string): string {
  const registered = listArtifacts(store.db, id).some((a) => a.path === relPath);
  if (!registered && !recordedLog(store, id, relPath)) {
    throw new ValidationError(`Artifact ${relPath} is not registered for ${id}.`);
  }
  const dir = jobArtifactDir(id, store.paths);
  let root: string;
  let file: string;
  try {
    root = realpathSync(dir);
    file = realpathSync(join(dir, ...relPath.split('/')));
  } catch {
    throw new ValidationError(`Artifact ${relPath} is missing on disk.`);
  }
  if (!file.startsWith(root + sep)) {
    throw new ValidationError(`Artifact ${relPath} is outside the job's artifact directory.`);
  }
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new ValidationError(`Artifact ${relPath} is missing on disk.`);
  }
}

/** The newest attachment with documented links; earlier ones are counted, not shown. */
function sessionView(events: Event[]): SessionView | null {
  const attachments = events.filter((e) => e.type === SESSION_EVENT);
  const last = attachments.at(-1);
  const ref = sessionOf(last);
  if (!last || !ref) return null;
  return {
    ...ref,
    attachedAt: last.createdAt,
    by: last.actor,
    links: sessionLinks(ref),
    previous: attachments.length - 1,
  };
}

/**
 * Every claude-code session attached to the job, newest first, one per ref: the only tie between a
 * job and a transcript. Read from all `session.attached` events, not the timeline's capped list.
 */
function claudeSessions(store: Store, id: string): ClaudeSession[] {
  return claudeSessionsOf(eventsOfTypes(store.db, id, [SESSION_EVENT]));
}

function claudeSessionsOf(attached: readonly Event[]): ClaudeSession[] {
  const out: ClaudeSession[] = [];
  for (const e of attached) {
    const s = sessionOf(e);
    if (s?.provider !== 'claude-code' || !UUID.test(s.ref) || out.some((x) => x.ref === s.ref)) {
      continue;
    }
    out.push({ ref: s.ref, attachedAt: e.createdAt });
  }
  return out;
}

/**
 * The Usage section: tokens per UTC hour over the last `hours` (24, 168, or 720) of every job,
 * archived included: recorded sessions from the database, the rest read live from the
 * transcripts of its claude-code sessions (a finished job's are recorded on that read). A job's
 * live span starts at its first claude-code attach and ends now, or at
 * `max(updatedAt, completedAt)` once finished.
 */
export function tokenUsage(store: Store, hours: string | null, at = Date.now()): UsageView {
  const range = USAGE_RANGES.find((r) => String(r) === hours);
  if (range === undefined) throw new UsageError('hours must be one of 24, 168, or 720');
  const jobs = listJobs(store.db).flatMap((j) => {
    const attached = eventsOfTypes(store.db, j.id, [SESSION_EVENT]);
    // Newest attach per ref, ordered oldest first.
    const sessions = claudeSessionsOf(attached).sort((a, b) =>
      a.attachedAt < b.attachedAt ? -1 : a.attachedAt > b.attachedAt ? 1 : 0,
    );
    // The first attach of any claude-code session (events are newest first); none: no live span.
    const firstAttach = attached
      .filter((e) => sessionOf(e)?.provider === 'claude-code')
      .reduce((t, e) => Math.min(t, Date.parse(e.createdAt)), Infinity);
    const terminal = TERMINAL_STATUSES.includes(j.status);
    const end = spanEnd(j, terminal, at);
    return [
      {
        id: j.id,
        title: j.title,
        refs: sessions.map((s) => s.ref),
        start: firstAttach,
        end,
        terminal,
      },
    ];
  });
  const stored = storedUsage(store, jobs, range, at);
  return readTokenUsage(claudeHome(), jobs, range, at, {}, stored);
}

/** The Session tab: the bounded tail of the newest attached claude-code session's transcript. */
export function sessionLog(store: Store, id: string): SessionLogView {
  getJob(store.db, id);
  // What the job's own session runs (the /factory skill); never an instruction to the dashboard user.
  const attach = `orch job session attach ${id} --provider claude-code`;
  return readSessionLog(claudeHome(), claudeSessions(store, id)[0]?.ref ?? null, attach);
}

/** The readiness grade for the job's repository and base branch. Reads Git and GitHub; writes nothing. */
export function readiness(store: Store, id: string): ReadinessView {
  const job = getJob(store.db, id);
  return { grade: gradedReadiness(job.repoPath, undefined, job.baseBranch).grade };
}

export function detail(store: Store, id: string): JobDetailView {
  const job = getJob(store.db, id);
  const artifacts = listArtifacts(store.db, id);
  const reviews = listReviews(store.db, id);
  const events = listEvents(store.db, id, TIMELINE_EVENTS);
  const contents: Record<string, string> = {};
  for (const a of artifacts) {
    if (a.bytes > INLINE_LIMIT) continue;
    try {
      contents[a.path] = artifactContent(store, id, a.path);
    } catch {
      /* missing on disk: shown as absent */
    }
  }
  let plan = null;
  let planError: string | null = null;
  try {
    plan = planJob(store, id);
  } catch (err) {
    planError = (err as Error).message;
  }
  const state = liveness(job);
  const evidence = {
    events: latestEventsByJob(store.db, [id], BLOCKER_EVENTS).get(id) ?? new Map<string, Event>(),
    artifacts,
    latestRun: latestRun(store.db, id)?.run ?? null,
  };
  // Without a readable worktree HEAD there is nothing to compare the verdict against.
  const ci = ciView(job, evidence.events, plan?.worktree?.head ?? undefined);
  const conflicts = baseConflicts(store, job, plan?.worktree ?? null);
  const choices = currentChoices(store, job);
  const actions = allowedActions(
    job,
    plan?.verification?.policy.authorization === 'required',
    ci.completion,
    conflicts,
    choices !== null,
  );
  return {
    job: safeJob(job),
    liveness: state,
    outcome: outcomeOf(state, job, ci.completion),
    artifacts,
    contents,
    rounds: rounds(reviews, artifacts),
    events,
    plan,
    planError,
    blocker: blockerOf(job, state, evidence),
    ci,
    progress: progressOf(job, evidence.events),
    timeline: timelineOf(events),
    flake: plan ? plan.flake : (currentFlakes(store).get(id) ?? null),
    prPhase: prPhase(job, ci.completion),
    actions,
    choices:
      choices?.map((c) => {
        const action = CHOICE_ACTIONS[c.kind];
        return { ...c, action, available: actions.includes(action) };
      }) ?? null,
    afterAction: choices === null ? null : afterAction(store, job),
    conflicts,
    links: {
      vscode: job.worktreePath ? vscodeLink(job.worktreePath) : null,
      checkout: vscodeLink(job.repoPath),
      pr: httpUrl(job.prUrl),
      repo: githubRepo(job.repo),
      branch: branchLink(job, events),
      branchUnpushed:
        !job.prUrl &&
        !events.some((e) => e.type === 'branch.pushed') &&
        githubRepo(job.repo) !== null,
      logs: logLinks(id, [
        ...(plan?.verification?.run?.checks.map((c) => c.outputPath) ?? []),
        ...ci.failures.map((f) => f.log),
      ]),
    },
    session: sessionView(events),
    claudeSessions: claudeSessions(store, id),
    resume: resumeOf(job, state),
    resumeCommand: `orch factory resume ${id} --session <name>`,
    supersedes: predecessorsOf(store.db, id).map((j) => j.id),
    merge: mergeView(store, job, plan?.worktree ?? null),
  };
}

/**
 * The branch on the web host, derived from the repository identity or the PR URL (no network
 * call). Only once the branch is known to be on the remote: a recorded PR or a `branch.pushed`
 * event (the only push orch makes); before that the link would be a 404.
 */
function branchLink(job: Job, events: Event[]): string | null {
  if (!job.branch || (!job.prUrl && !events.some((e) => e.type === 'branch.pushed'))) return null;
  const base =
    githubRepo(job.repo) ??
    /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(job.prUrl ?? '')?.[1] ??
    null;
  return base && `${base}/tree/${job.branch.split('/').map(encodeURIComponent).join('/')}`;
}

/** The artifact route of each log-shaped path, each segment encoded; other paths get none. */
function logLinks(id: string, paths: unknown[]): Record<string, string> {
  return Object.fromEntries(
    paths
      .filter(isLogPath)
      .map((p) => [
        p,
        `/api/jobs/${id}/artifacts/${p.split('/').map(encodeURIComponent).join('/')}`,
      ]),
  );
}

/** `https://github.com/<owner>/<repo>` for a github.com identity; null for any other remote. */
function githubRepo(repo: string): string | null {
  return /^github\.com\/[^/]+\/[^/]+$/.test(repo) ? `https://${repo}` : null;
}

/** The URL itself when it parses with an http(s) scheme, else null; stored URLs are not trusted. */
function httpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function vscodeLink(dir: string): string {
  return `vscode://file/${dir.split('\\').join('/')}`;
}

/** Validate an action request body from the network before it reaches the domain layer. */
export function parseAction(body: unknown): ActionRequest & { to?: Stage } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;
  const allowed = new Set(['action', 'reason', 'force', 'to', 'choice', 'content']);
  for (const k of Object.keys(b)) {
    if (!allowed.has(k)) throw new ValidationError(`Unknown field: ${k}`);
  }
  const action = b['action'];
  if (typeof action !== 'string' || !DASHBOARD_ACTIONS.includes(action as DashboardAction)) {
    throw new ValidationError(`action must be one of ${DASHBOARD_ACTIONS.join(', ')}`);
  }
  const out: ActionRequest & { to?: Stage } = { action: action as DashboardAction };
  if (b['reason'] !== undefined) {
    if (typeof b['reason'] !== 'string' || b['reason'].length > 500) {
      throw new ValidationError('reason must be a string of at most 500 characters');
    }
    out.reason = b['reason'];
  }
  if (b['force'] !== undefined) {
    if (typeof b['force'] !== 'boolean') throw new ValidationError('force must be a boolean');
    out.force = b['force'];
  }
  if (b['to'] !== undefined) {
    if (typeof b['to'] !== 'string' || !STAGES.includes(b['to'] as Stage)) {
      throw new ValidationError(`to must be one of ${STAGES.join(', ')}`);
    }
    out.to = b['to'] as Stage;
  }
  const choice = b['choice'];
  if ((choice !== undefined) !== (action === 'answer')) {
    throw new ValidationError('choice is required with action answer, and only with it');
  }
  if (choice !== undefined) {
    if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0) {
      throw new ValidationError('choice must be a non-negative integer');
    }
    out.choice = choice;
  }
  const content = b['content'];
  if ((content !== undefined) !== (action === 'edit-spec')) {
    throw new ValidationError('content is required with action edit-spec, and only with it');
  }
  if (content !== undefined) {
    if (typeof content !== 'string') throw new ValidationError('content must be a string');
    out.content = content;
  }
  return out;
}

export function act(store: Store, id: string, body: unknown): ActionResponse {
  const req = parseAction(body);
  const r = dashboardAction(store, id, {
    action: req.action,
    reason: req.reason,
    force: req.force,
    to: req.to,
    choice: req.choice,
    content: req.content,
  });
  return r.resumeCommand
    ? { job: r.job, message: r.message, resumeCommand: r.resumeCommand }
    : { job: r.job, message: r.message };
}
