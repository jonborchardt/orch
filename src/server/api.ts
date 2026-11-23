/**
 * Dashboard read models and action dispatch. Reads go through storage and ops; writes go through
 * ops/actions.ts (which uses the same validated transitions as the CLI). No SQL here.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import { claudeHome, jobArtifactDir } from '../core/paths.ts';
import { SESSION_EVENT, sessionLinks, UUID } from '../core/session.ts';
import {
  cannotRefreshPr,
  now,
  prPhase,
  STAGES,
  type Stage,
  TERMINAL_STATUSES,
} from '../core/workflow.ts';
import {
  allowedActions,
  DASHBOARD_ACTIONS,
  type DashboardAction,
  dashboardAction,
  withoutToken,
} from '../ops/actions.ts';
import { planJob } from '../ops/factory.ts';
import { mergeView } from '../ops/merge-view.ts';
import { currentFlakes } from '../ops/verify.ts';
import { baseConflicts } from '../ops/worktree.ts';
import { artifactsByJob, listArtifacts } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { eventsOfTypes, latestEventsByJob, listEvents } from '../storage/events.ts';
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
import { readSessionLog } from './transcript.ts';
import type {
  ActionRequest,
  ActionResponse,
  BoardRow,
  ClaudeSession,
  JobDetailView,
  RoundView,
  SafeJob,
  SessionLogView,
  SessionView,
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
 * `ci/<sha7>/<name>.log` (ops/github.ts). Mirrored by `isLogPath` in web/src/format.ts.
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
  const out: ClaudeSession[] = [];
  for (const e of eventsOfTypes(store.db, id, [SESSION_EVENT])) {
    const s = sessionOf(e);
    if (s?.provider !== 'claude-code' || !UUID.test(s.ref) || out.some((x) => x.ref === s.ref)) {
      continue;
    }
    out.push({ ref: s.ref, attachedAt: e.createdAt });
  }
  return out;
}

/** The Session tab: the bounded tail of the newest attached claude-code session's transcript. */
export function sessionLog(store: Store, id: string): SessionLogView {
  getJob(store.db, id);
  // What the job's own session runs (the /factory skill); never an instruction to the dashboard user.
  const attach = `orch job session attach ${id} --provider claude-code`;
  return readSessionLog(claudeHome(), claudeSessions(store, id)[0]?.ref ?? null, attach);
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
    actions: allowedActions(
      job,
      plan?.verification?.policy.authorization === 'required',
      ci.completion,
      conflicts,
    ),
    conflicts,
    links: {
      vscode: job.worktreePath ? vscodeLink(job.worktreePath) : null,
      checkout: vscodeLink(job.repoPath),
      pr: httpUrl(job.prUrl),
      repo: githubRepo(job.repo),
      branch: branchLink(job, events),
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
  const allowed = new Set(['action', 'reason', 'force', 'to']);
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
  return out;
}

export function act(store: Store, id: string, body: unknown): ActionResponse {
  const req = parseAction(body);
  const r = dashboardAction(store, id, {
    action: req.action,
    reason: req.reason,
    force: req.force,
    to: req.to,
  });
  return r.resumeCommand
    ? { job: r.job, message: r.message, resumeCommand: r.resumeCommand }
    : { job: r.job, message: r.message };
}
