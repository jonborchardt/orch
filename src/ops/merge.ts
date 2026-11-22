/**
 * Merging a completed job's PR: the one operation behind `orch job merge`, the dashboard's Merge,
 * and whatever runs jobs unattended later (decision 2026-11-20-orch-job-merge).
 *
 * GitHub is the authority. Every call reads the PR fresh and decides with `mergeDecision`
 * (core/workflow.ts); a merge is `gh pr merge --merge --match-head-commit <ciHead>` and counts
 * only once a second read says MERGED, whatever gh's exit status was. What GitHub confirmed is
 * recorded in one transaction with the job's ticket (`recordMerge`). Nothing is kept between
 * calls, so a call after a crash, a timeout, or someone else's merge starts from GitHub's answer
 * and finishes the record. Nothing here changes a job's stage, status, or CI verdict.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ToolError, ValidationError, WorkflowError } from '../core/errors.ts';
import {
  type Completion,
  completionOf,
  type MergeBlock,
  mergeDecision,
  type MergeStep,
  touchesWorkflows,
} from '../core/workflow.ts';
import { baseRef } from '../git/repo.ts';
import { tryGit } from '../git/run.ts';
import { type GhPr, mergePr, prWorkflowState, viewPr } from '../integrations/github.ts';
import type { Store } from '../storage/client.ts';
import { latestEventsByJob } from '../storage/events.ts';
import {
  type ConfirmedMerge,
  getJob,
  pendingMerge,
  predecessorsOf,
  recordMerge,
  recordPrState,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import type { TicketMergeOutcome } from '../storage/tickets.ts';
import { ticketKey } from '../core/tickets.ts';
import { dispatchJob } from './dispatch.ts';
import { configPath, loadConfig } from './factory.ts';
import { ghCwd } from './github.ts';
import { type LeaseMode, withLease } from './lease.ts';
import { jobRepository } from './repo.ts';

/** gh may take up to two minutes per call; the episode makes three. */
const MERGE_LEASE_MINUTES = 10;

export const MERGE_OUTCOMES = [
  'merged',
  'already_merged',
  'waiting',
  'reland',
  'blocked',
  'error',
] as const;
export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

export interface MergeResult {
  /**
   * `merged`: this call merged the PR and GitHub confirmed it. `already_merged`: GitHub had
   * merged it before; the record is complete now. `waiting`: GitHub is still computing
   * mergeability; call again. `reland`: the PR conflicts, and `relandJob` replaces this job.
   * `blocked`: refused, see `code`; a retry changes nothing until that state does. `error`: a
   * tool or GitHub failure left the outcome unknown; calling again is safe.
   */
  outcome: MergeOutcome;
  /** Why, for `blocked`. */
  code: MergeBlock | null;
  reason: string;
  jobId: string;
  ticketId: number | null;
  prUrl: string | null;
  base: string;
  /** The PR head GitHub reported in this call. */
  prHead: string | null;
  /** The head the job's passing CI verdict was recorded for (`ciHead`). */
  verifiedHead: string | null;
  mergeCommit: string | null;
  /** Merged, and the merged head is `verifiedHead`. */
  verified: boolean;
  /** The job's ticket after this call; null without a ticket or before a merge is recorded. */
  ticket: TicketMergeOutcome | null;
  /** The job that re-lands (or already replaced) this one. */
  relandJob: string | null;
}

export interface MergeInput {
  /** Owner of the short episode; recorded as the actor of what it writes. */
  session: string;
  /** Take the job from a session whose lease is still live. */
  force?: boolean | undefined;
  /**
   * `dashboard` is a human's click, which is its own authorization. `session` (the default) is
   * any other caller and needs the repository opted in (`mergeAuthorized`).
   */
  mode?: LeaseMode | undefined;
  /** Create a re-land job when the PR conflicts (default). False reports `conflict` instead. */
  reland?: boolean | undefined;
}

// ---------------------------------------------------------------------------------------------
// Authorization: a local, per-repository opt-in in the user's own factory.json.

export interface MergeAuthorization {
  repo: string;
  enabled: boolean;
  /** The file that holds the setting. */
  file: string;
}

/** Whether `orch job merge` may merge in the repository with this identity. Off unless opted in. */
export function mergeAuthorized(store: Store, repo: string): boolean {
  return loadConfig(store).mergeRepos.includes(repo);
}

function identityAt(path: string): string {
  const { repo } = jobRepository(path);
  if (repo.remote === undefined) {
    throw new ValidationError(
      `${repo.root} has no origin remote, so it has no pull requests to merge.`,
    );
  }
  return repo.identity;
}

export function mergeAuthorization(store: Store, path: string): MergeAuthorization {
  const repo = identityAt(path);
  return { repo, enabled: mergeAuthorized(store, repo), file: configPath(store) };
}

/** Opt the repository at `path` in or out, in the user's factory.json; other keys are kept. */
export function setMergeAuthorization(
  store: Store,
  path: string,
  enabled: boolean,
): MergeAuthorization {
  const repo = identityAt(path);
  const repos = new Set(loadConfig(store).mergeRepos); // also validates the file
  if (enabled) repos.add(repo);
  else repos.delete(repo);
  const file = configPath(store);
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as object) : {};
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...raw, mergeRepos: [...repos].sort() }, null, 2)}\n`);
  return { repo, enabled, file };
}

// ---------------------------------------------------------------------------------------------

/** How the job completed, from its newest `job.completed` event. */
export function completionFor(store: Store, job: Job): Completion {
  const completed = latestEventsByJob(store.db, [job.id], ['job.completed'])
    .get(job.id)
    ?.get('job.completed');
  return completionOf(job.stage, completed?.payload);
}

/**
 * Create the job that re-lands `before` on its base and mark `before` superseded by it, in one
 * transaction (`createJob`), as the holder of `token`. The new job keeps the ticket; nothing else
 * happens: no claim, worktree, or session. Refused when `before` was already superseded.
 */
export function relandJob(store: Store, before: Job, token: string, session: string): Job {
  const sentence =
    `Re-land the work of ${before.id} (PR ${before.prUrl ?? '?'}, branch ${before.branch ?? '?'}) ` +
    `on the current ${before.baseBranch}: start from that branch's changes, resolve the conflicts ` +
    `with ${before.baseBranch}, keep the original scope.`;
  return dispatchJob(store, {
    repo: before.repoPath,
    base: before.baseBranch,
    // The re-land works on the same ticket; `before` is finished, so the ticket is free.
    ticket: before.ticketId ?? undefined,
    supersedes: { id: before.id, token },
    title: `${before.title} (re-land)`,
    description: before.description ? `${before.description}\n\n${sentence}` : sentence,
    session,
    cwd: before.repoPath,
  }).job;
}

interface Seen {
  pr: GhPr | null;
  step: MergeStep;
}

function look(store: Store, job: Job, input: MergeInput): Seen {
  if (!job.prUrl) {
    return { pr: null, step: { step: 'blocked', code: 'no-pr', reason: 'the job has no PR' } };
  }
  const cwd = ghCwd(job);
  const pr = viewPr(job.prUrl, cwd);
  const step = mergeDecision(job, pr, {
    completion: completionFor(store, job),
    authorized: input.mode === 'dashboard' || mergeAuthorized(store, job.repo),
    isReland: predecessorsOf(store.db, job.id).length > 0,
    changesWorkflows: changesWorkflows(cwd, job),
    byHuman: input.mode === 'dashboard',
  });
  return { pr, step };
}

/**
 * Whether the job's diff, from its merge base with the base branch to `ciHead`, touches
 * `.github/workflows/` (added, edited, deleted, or renamed; renames count both sides). Read from
 * Git, never from the repository's configuration; true when Git cannot answer (fail closed).
 */
function changesWorkflows(cwd: string, job: Job): boolean {
  const base = baseRef(cwd, job.baseBranch);
  if (!base || !job.ciHead) return true;
  const mergeBase = tryGit(cwd, 'merge-base', base, job.ciHead);
  if (!mergeBase) return true;
  // -z: unquoted names, so an odd character cannot hide the prefix.
  const names = tryGit(cwd, 'diff', '--name-only', '--no-renames', '-z', mergeBase, job.ciHead);
  if (names === undefined) return true;
  return touchesWorkflows(names.split('\0').filter((l) => l !== ''));
}

function result(
  job: Job,
  pr: GhPr | null,
  o: Partial<MergeResult> & Pick<MergeResult, 'outcome' | 'reason'>,
): MergeResult {
  return {
    code: null,
    jobId: job.id,
    ticketId: job.ticketId,
    prUrl: job.prUrl,
    base: job.baseBranch,
    prHead: pr?.headSha ?? null,
    verifiedHead: job.ciHead,
    mergeCommit: pr?.mergeCommit ?? null,
    verified: false,
    ticket: null,
    relandJob: null,
    ...o,
  };
}

const short = (sha: string | null) => sha?.slice(0, 7) ?? '?';

/** One sentence (with a leading space) on what the merge meant for the ticket; empty without one. */
export function ticketText(t: TicketMergeOutcome | null): string {
  if (t === null) return '';
  const key = ticketKey(t.id);
  if (t.completed) return ` Ticket ${key} is done.`;
  return ` Ticket ${key} stays ${t.status}: ${t.reason ?? 'not closed'}.`;
}

function mergedText(job: Job, pr: GhPr, m: ConfirmedMerge, t: TicketMergeOutcome | null): string {
  const unverified = m.verified ? '' : ` Not verified: ${m.reason ?? 'the head differs'}.`;
  return (
    `${job.prUrl ?? ''} is merged into ${job.baseBranch} at ${short(pr.headSha)} ` +
    `(merge commit ${short(m.mergeCommit)}).${unverified}${ticketText(t)}`
  );
}

function confirmed(
  pr: GhPr,
  mergeCommit: string,
  step: { verified: boolean; reason: string | null },
): ConfirmedMerge {
  return { head: pr.headSha, mergeCommit, verified: step.verified, reason: step.reason };
}

/** GitHub says MERGED but has not named the merge commit yet: nothing is recorded without it. */
function noCommit(job: Job, pr: GhPr): MergeResult {
  return result(job, pr, {
    outcome: 'error',
    reason: `GitHub reports ${job.prUrl ?? ''} MERGED but no merge commit yet; run the command again to record it`,
  });
}

/** The outcomes that write nothing; null when the step needs the job's lease. */
function idle(store: Store, job: Job, seen: Seen, input: MergeInput): MergeResult | null {
  const { pr, step } = seen;
  if (step.step === 'blocked') {
    return result(job, pr, {
      outcome: 'blocked',
      code: step.code,
      reason: step.reason,
      relandJob: job.supersededBy,
    });
  }
  if (step.step === 'wait') return result(job, pr, { outcome: 'waiting', reason: step.reason });
  if (step.step === 'reland' && input.reland === false) {
    return result(job, pr, { outcome: 'blocked', code: 'conflict', reason: step.reason });
  }
  if (step.step === 'record' && pr !== null) {
    if (pr.mergeCommit === null) return noCommit(job, pr);
    const m = confirmed(pr, pr.mergeCommit, step);
    const pending = pendingMerge(store.db, job.id, m);
    if (pending.changed) return null;
    return result(job, pr, {
      outcome: 'already_merged',
      verified: step.verified,
      ticket: pending.ticket,
      reason: mergedText(job, pr, m, pending.ticket),
    });
  }
  return null;
}

/** The steps that write, as the holder of `token`. */
function act(store: Store, job: Job, seen: Seen, input: MergeInput, token: string): MergeResult {
  const { pr, step } = seen;
  const auth = { token };
  const url = job.prUrl ?? '';
  if (pr === null) throw new Error('unreachable: a step that writes has a PR');
  const record = (now: GhPr, m: ConfirmedMerge, outcome: 'merged' | 'already_merged') => {
    const { ticket } = recordMerge(store, job.id, auth, m);
    return result(job, now, {
      outcome,
      verified: m.verified,
      ticket,
      reason: mergedText(job, now, m, ticket),
    });
  };

  if (step.step === 'record') {
    if (pr.mergeCommit === null) return noCommit(job, pr);
    return record(pr, confirmed(pr, pr.mergeCommit, step), 'already_merged');
  }

  if (step.step === 'reland') {
    const observed = {
      event: 'pr.observed',
      state: prWorkflowState(pr),
      head: pr.headSha,
      mergeable: pr.mergeable,
    } as const;
    recordPrState(store, job.id, auth, observed);
    try {
      const created = relandJob(store, job, token, input.session);
      return result(job, pr, {
        outcome: 'reland',
        relandJob: created.id,
        reason:
          `${step.reason}. Created ${created.id} to re-land the work; ${job.id} is superseded and ` +
          `its PR must not merge. Run /factory ${created.id}, then merge that job.`,
      });
    } catch (err) {
      if (!(err instanceof ValidationError) && !(err instanceof WorkflowError)) throw err;
      return result(job, pr, {
        outcome: 'blocked',
        code: 'reland-refused',
        reason: `${step.reason}, and no re-land job could be created: ${err.message}`,
      });
    }
  }

  if (step.step !== 'merge') throw new Error(`unreachable: ${step.step} writes nothing`);
  const cwd = ghCwd(job);
  const failed = mergePr(url, step.head, cwd);
  // gh's exit status is a hint: a timeout or a dropped connection can follow a merge GitHub made.
  let after: GhPr;
  try {
    after = viewPr(url, cwd);
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    return result(job, pr, {
      outcome: 'error',
      reason:
        `gh pr merge was run (${failed ?? 'it reported success'}), but GitHub could not be read ` +
        `afterwards: ${err.message}. Run the command again; it records what GitHub confirms.`,
    });
  }
  if (after.state === 'MERGED') {
    if (after.mergeCommit === null) return noCommit(job, after);
    const verified = after.headSha === step.head;
    const reason = verified
      ? null
      : `the PR was merged at ${short(after.headSha)}, not the verified ${short(step.head)}`;
    return record(
      after,
      { head: after.headSha, mergeCommit: after.mergeCommit, verified, reason },
      'merged',
    );
  }
  if (failed !== null) {
    recordPrState(store, job.id, auth, { event: 'pr.merged', head: step.head, error: failed });
    return result(job, after, {
      outcome: 'blocked',
      code: 'github-refused',
      reason: `gh pr merge failed: ${failed}`,
    });
  }
  return result(job, after, {
    outcome: 'error',
    reason: `gh pr merge reported success, but GitHub still reports ${url} ${after.state}; run the command again`,
  });
}

/**
 * Merge the job's PR if every gate holds, or finish recording a merge GitHub already made. The
 * PR is read and judged without the lease first, so a refusal, a wait, or a completed record
 * writes nothing at all; a step that writes claims the job for a short episode and reads GitHub
 * again inside it. A tool failure is the `error` outcome, never a guess; another session's live
 * lease is an ownership error.
 */
export function mergeJob(store: Store, id: string, input: MergeInput): MergeResult {
  const before = getJob(store.db, id);
  try {
    return (
      idle(store, before, look(store, before, input), input) ??
      withLease(
        store,
        before,
        input.session,
        input.force,
        (token) => {
          const job = getJob(store.db, id);
          const seen = look(store, job, input);
          return idle(store, job, seen, input) ?? act(store, job, seen, input, token);
        },
        input.mode ?? 'session',
        MERGE_LEASE_MINUTES,
      )
    );
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    return result(before, null, { outcome: 'error', reason: err.message });
  }
}
