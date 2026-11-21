/**
 * Dispatch: prepare a factory job for another repository (or this one) so that an independent
 * session can run it, and give the initiating session a view of all its jobs.
 *
 * Dispatch creates the job and nothing else. It does not claim it, create a worktree, or start a
 * session: the session mechanism that is actually supported here (VS Code's Agents window, through
 * the host's `create_session` tool) creates its own worktree of the repository before the session
 * starts, and the child's `orch factory resume --adopt <that worktree>` records it. The result
 * carries exactly what the launcher needs: the workspace, the prompt, and fallbacks.
 */
import { ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import type { SessionRef } from '../core/session.ts';
import { now, type Stage, type Status, TERMINAL_STATUSES } from '../core/workflow.ts';
import { findProjectRoot } from '../core/paths.ts';
import { baseRef } from '../git/repo.ts';
import type { Store } from '../storage/client.ts';
import { latestEventsByJob } from '../storage/events.ts';
import { createJob, listJobs, sessionsByJob } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { loadConfig } from './factory.ts';
import { issue as ghIssue } from './github.ts';
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
  /** A re-land: the finished job this one replaces, superseded in the creating transaction. */
  supersedes?: { id: string; token: string | undefined } | undefined;
  /** The initiating session's name; recorded as the actor. */
  session: string;
  cwd: string;
}

export interface Launch {
  /** Repository root: the workspace an independent session is created for. */
  workspace: string;
  /** The session needs its own worktree of that workspace (`create_session` `worktree: true`). */
  worktree: true;
  title: string;
  /** Initial prompt: the skill command plus one line of context. */
  prompt: string;
  /** Equivalent launches when the host tool is unavailable; the human runs one of them. */
  fallback: string[];
}

export interface DispatchResult {
  job: Job;
  /** True when an active job for the same repository and issue already existed; nothing was created. */
  duplicate: boolean;
  readiness: Readiness;
  launch: Launch;
}

/** `#45`, `45` → `#45`; URLs and other references stay as written. */
export function normalizeIssue(ref: string): string {
  const m = /^#?(\d+)$/.exec(ref.trim());
  return m ? `#${m[1] ?? ''}` : ref.trim();
}

export function launchFor(job: Job): Launch {
  const id = job.id;
  return {
    workspace: job.repoPath,
    worktree: true,
    title: `factory ${id}: ${job.title}`.slice(0, 80),
    prompt:
      `/factory ${id}\n\n` +
      `Factory job ${id} for ${job.repo}: ${job.title}. Run it from the worktree this session ` +
      'was created in (the skill adopts it as the job worktree) and stop when the job needs a human.',
    fallback: [
      `cd "${job.repoPath}" && claude --worktree ${id} "/factory ${id}"   # terminal session in its own worktree`,
      `code --agents "${job.repoPath}"   # VS Code Agents window: New Session > New Worktree, then: /factory ${id}`,
    ],
  };
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
    if (existing) return { job: existing, duplicate: true, readiness, launch: launchFor(existing) };
  }
  let title = input.title;
  let description = input.description;
  if ((!title || description === undefined) && input.issue) {
    const found = ghIssue(input.issue, repo.root);
    if (!title) ({ title } = found); // also replaces an empty --title, as before
    description ??= `${found.url}\n\n${found.body}`;
  }
  if (title === undefined || title === '') title = forTicket?.title;
  description ??= forTicket?.description;
  if (!title) {
    throw new ValidationError(
      'Provide --title (or --issue or --ticket so the title can be fetched).',
    );
  }
  const config = loadConfig(store);
  const job = createJob(store, {
    title,
    description,
    ticketId: forTicket?.ticket.id,
    issueRef: issue,
    repo: repo.identity,
    repoPath: repo.root,
    baseBranch: base,
    maxRounds: input.maxRounds ?? config.maxRounds,
    maxCiRepairs: config.maxCiRepairs,
    actor: input.session,
    supersedes: input.supersedes,
  });
  return { job, duplicate: false, readiness, launch: launchFor(job) };
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
