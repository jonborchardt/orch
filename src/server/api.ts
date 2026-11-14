/**
 * Dashboard read models and action dispatch. Reads go through storage and ops; writes go through
 * ops/actions.ts (which uses the same validated transitions as the CLI). No SQL here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import { jobArtifactDir } from '../core/paths.ts';
import { now, STAGES, type Stage } from '../core/workflow.ts';
import {
  allowedActions,
  DASHBOARD_ACTIONS,
  type DashboardAction,
  dashboardAction,
  withoutToken,
} from '../ops/actions.ts';
import { planJob } from '../ops/factory.ts';
import { artifactsByJob, listArtifacts } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { latestEventsByJob, listEvents } from '../storage/events.ts';
import { getJob, listJobs, listReviews, reviewsByJob } from '../storage/jobs.ts';
import type { Artifact, Job, Review } from '../storage/schema.ts';
import { latestRun, latestRunsByJob } from '../storage/verification.ts';
import { BLOCKER_EVENTS, blockerOf, liveness, resumeCommand } from './status.ts';
import type {
  ActionRequest,
  ActionResponse,
  BoardRow,
  JobDetailView,
  RoundView,
  SafeJob,
} from './types.ts';

export { liveness } from './status.ts';

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
  const runsOf = latestRunsByJob(store.db, ids);
  return jobs.map((job) => {
    const reviews = (reviewsOf.get(job.id) ?? []).filter((r) => r.round === job.round);
    const artifacts = artifactsOf.get(job.id) ?? [];
    const state = liveness(job);
    const evidence = {
      events: eventsOf.get(job.id) ?? new Map(),
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
    const end = job.completedAt ?? ts;
    return {
      id: job.id,
      title: job.title,
      repo: job.repo,
      repoPath: job.repoPath,
      stage: job.stage,
      status: job.status,
      liveness: state,
      round: job.round,
      maxRounds: job.maxRounds,
      owner,
      worktreePath: job.worktreePath,
      branch: job.branch,
      reviews: reviews.map((r) => ({ reviewer: r.reviewer, verdict: r.verdict })),
      blocking: blockingOf(artifacts, job.round) ?? blockingOf(artifacts, job.round - 1),
      blocker: blockerOf(job, state, evidence),
      resume: resumeCommand(job, state),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      elapsedMs: Math.max(0, Date.parse(end) - Date.parse(job.createdAt)),
      pr: {
        url: job.prUrl,
        state: job.prState,
        ciStatus: job.ciStatus,
        ciCheckedAt: job.ciCheckedAt,
      },
    };
  });
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

/** Content of a registered artifact only; anything else under the directory is not served. */
export function artifactContent(store: Store, id: string, relPath: string): string {
  const registered = listArtifacts(store.db, id).find((a) => a.path === relPath);
  if (!registered) throw new ValidationError(`Artifact ${relPath} is not registered for ${id}.`);
  try {
    return readFileSync(join(jobArtifactDir(id, store.paths), ...relPath.split('/')), 'utf8');
  } catch {
    throw new ValidationError(`Artifact ${relPath} is missing on disk.`);
  }
}

export function detail(store: Store, id: string): JobDetailView {
  const job = getJob(store.db, id);
  const artifacts = listArtifacts(store.db, id);
  const reviews = listReviews(store.db, id);
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
    events: latestEventsByJob(store.db, [id], BLOCKER_EVENTS).get(id) ?? new Map(),
    artifacts,
    latestRun: latestRun(store.db, id)?.run ?? null,
  };
  return {
    job: safeJob(job),
    liveness: state,
    artifacts,
    contents,
    rounds: rounds(reviews, artifacts),
    events: listEvents(store.db, id, 500),
    worktree: plan?.worktree ?? null,
    plan,
    planError,
    blocker: blockerOf(job, state, evidence),
    actions: allowedActions(job, plan?.verification?.policy.authorization === 'required'),
    links: {
      vscode: job.worktreePath ? vscodeLink(job.worktreePath) : null,
      checkout: vscodeLink(job.repoPath),
      pr: job.prUrl,
    },
    resume: resumeCommand(job, state),
    resumeCommand: `orch factory resume ${id} --session <name>`,
  };
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
