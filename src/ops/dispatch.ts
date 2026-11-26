/**
 * Dispatch: create a factory job for another repository (or this one) without claiming it, and
 * give a session a view of all its jobs.
 *
 * Dispatch creates the job and nothing else. It does not claim it, create a worktree, or start a
 * session: the factory controller (`orch start`, `orch do`) or an interactive `/factory <id>`
 * runs it (decision 2026-11-25-retire-dispatch-launch).
 */
import { ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import type { SessionRef } from '../core/session.ts';
import { type JobMode, now, type Stage, type Status, TERMINAL_STATUSES } from '../core/workflow.ts';
import { findProjectRoot } from '../core/paths.ts';
import { baseRef } from '../git/repo.ts';
import type { Store } from '../storage/client.ts';
import { latestEventsByJob } from '../storage/events.ts';
import { listJobs, sessionsByJob } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { createRequestedJob } from './factory.ts';
import { checkReadiness, type Readiness } from './init.ts';
import { findJobs, jobRepository } from './repo.ts';
import { ticketJobRequest } from './tickets.ts';

export interface DispatchInput {
  /** Target repository: a path inside it. Defaults to `cwd`. */
  repo?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  issue?: string | undefined;
  base?: string | undefined;
  maxRounds?: number | undefined;
  /** Ticket the job works on; its repository, title, and body are the defaults. */
  ticket?: string | number | undefined;
  /** `fast` only from the controller's `orch do --fast`; default `full`. */
  mode?: JobMode | undefined;
  /** A re-land: the finished job this one replaces, superseded in the creating transaction. */
  supersedes?: { id: string; token: string | undefined } | undefined;
  /** The initiating session's name; recorded as the actor. */
  session: string;
  cwd: string;
}

export interface DispatchResult {
  job: Job;
  /** True when an active job for the same repository and issue already existed; nothing was created. */
  duplicate: boolean;
  readiness: Readiness;
}

/** `#45`, `45` → `#45`; URLs and other references stay as written. */
export function normalizeIssue(ref: string): string {
  const m = /^#?(\d+)$/.exec(ref.trim());
  return m ? `#${m[1] ?? ''}` : ref.trim();
}

/**
 * Validate the target and create the job. Refuses, creating nothing, unless the repository's
 * verification policy is ready (committed, trusted, runnable) and the base branch exists. A
 * repeated dispatch for the same repository and issue returns the existing active job.
 */
export function dispatchJob(store: Store, input: DispatchInput): DispatchResult {
  // Judge readiness against what the job will use: the primary checkout and its branch, also
  // when the target is a linked worktree. Outside any repository, readiness reports why.
  const forTicket =
    input.ticket === undefined ? undefined : ticketJobRequest(store, input.ticket, input.repo);
  const target = forTicket?.path ?? input.repo ?? input.cwd;
  const resolved = findProjectRoot(target) ? jobRepository(target, input.base) : undefined;
  const readiness = checkReadiness(
    input.cwd,
    resolved?.repo.root ?? forTicket?.path ?? input.repo,
    resolved?.base ?? input.base,
  );
  if (!readiness.ready || readiness.root === null || resolved === undefined) {
    throw new ValidationError(
      `Target repository is not ready for the factory (${readiness.status}): ${readiness.detail}` +
        `${readiness.next ? ` Next: ${readiness.next}` : ''} Nothing was created.`,
    );
  }
  const { repo, base } = resolved;
  if (!baseRef(repo.root, base)) {
    throw new ValidationError(
      `Base branch ${base} not found in ${repo.root} (local or origin). Nothing was created.`,
    );
  }
  const issue = input.issue === undefined ? undefined : normalizeIssue(input.issue);
  if (issue !== undefined) {
    const existing = findJobs(store, { repo: repo.root }).find(
      (j) => j.issueRef === issue && !TERMINAL_STATUSES.includes(j.status),
    );
    if (existing) return { job: existing, duplicate: true, readiness };
  }
  const job = createRequestedJob(store, { ...input, issueRef: issue, forTicket, repo, base });
  return { job, duplicate: false, readiness };
}

export interface FactoryRow {
  id: string;
  title: string;
  repo: string;
  repoPath: string;
  stage: Stage;
  status: Status;
  round: number;
  owner: { session: string; live: boolean } | null;
  /** The job waits for a person (needs-human). */
  needsHuman: boolean;
  blockedReason: string | null;
  worktreePath: string | null;
  branch: string | null;
  pr: { url: string | null; state: string | null; ciStatus: string | null };
  /** Current execution session, when one was attached. */
  session: SessionRef | null;
  /** The command a session runs to continue the job; null while a live lease is held or when finished. */
  resume: string | null;
  updatedAt: string;
}

/** One row per job for the initiating session: state, attention needed, where to go. */
export function listFactory(
  store: Store,
  filter: { repo?: string | undefined } = {},
): FactoryRow[] {
  const jobs =
    filter.repo === undefined ? listJobs(store.db) : findJobs(store, { repo: filter.repo });
  const ids = jobs.map((j) => j.id);
  const sessions = sessionsByJob(store.db, ids);
  const blocked = latestEventsByJob(store.db, ids, ['job.blocked']);
  const ts = now();
  return jobs.map((job) => {
    const live = job.ownerSession !== null && !leaseExpired(job, ts);
    const finished = TERMINAL_STATUSES.includes(job.status);
    const reason = blocked.get(job.id)?.get('job.blocked')?.payload['reason'];
    return {
      id: job.id,
      title: job.title,
      repo: job.repo,
      repoPath: job.repoPath,
      stage: job.stage,
      status: job.status,
      round: job.round,
      owner: job.ownerSession === null ? null : { session: job.ownerSession, live },
      needsHuman: job.stage === 'needs-human',
      blockedReason: job.stage === 'needs-human' && typeof reason === 'string' ? reason : null,
      worktreePath: job.worktreePath,
      branch: job.branch,
      pr: { url: job.prUrl, state: job.prState, ciStatus: job.ciStatus },
      session: sessions.get(job.id) ?? null,
      resume: finished || live ? null : `orch factory resume ${job.id} --session <name>`,
      updatedAt: job.updatedAt,
    };
  });
}
