/**
 * Merging a completed job's PR: the one operation behind `orch job merge`, the dashboard's Merge,
 * and whatever runs jobs unattended later (decision 2026-11-20-orch-job-merge).
 *
 * GitHub is the authority. Every call reads the PR fresh and decides with `mergeDecision`
 * (core/workflow.ts); a merge is `gh pr merge --merge --match-head-commit <ciHead>` and counts
 * only once a second read says MERGED, whatever gh's exit status was. What GitHub confirmed is
 * recorded in one transaction with the job's ticket (`recordMerge`). Nothing is kept between
 * calls, so a call after a crash, a timeout, or someone else's merge starts from GitHub's answer
 * and finishes the record. Nothing here changes a job's stage, status, or CI verdict, except the
 * reopen into pr after a moved base was merged into the branch (`baseMoved`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { MergeConflictError, ToolError, ValidationError, WorkflowError } from '../core/errors.ts';
import {
  type Completion,
  completionOf,
  type MergeBlock,
  mergeDecision,
  type MergeStep,
  touchesWorkflows,
} from '../core/workflow.ts';
import {
  baseContains,
  type GhPr,
  type GhPrFile,
  listPrFiles,
  mergePr,
  viewPr,
} from '../integrations/github.ts';
import type { ReadinessGrade } from '../core/readiness.ts';
import type { Store } from '../storage/client.ts';
import { latestEventsByJob } from '../storage/events.ts';
import {
  baseReopens,
  type ConfirmedMerge,
  getJob,
  pendingMerge,
  predecessorsOf,
  recordMerge,
  recordEvent,
  recordPrState,
  reopenJob,
  siblingOnTicket,
  transitionJob,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import type { TicketMergeOutcome } from '../storage/tickets.ts';
import { ticketKey } from '../core/tickets.ts';
import { dispatchJob } from './dispatch.ts';
import { configPath, loadConfig } from './factory.ts';
import { gradedReadiness } from './init.ts';
import { ghCwd, observePr } from './github.ts';
import { type LeaseMode, withLease } from './lease.ts';
import { jobRepository } from './repo.ts';
import { dropWorktree, integrateBase, type IntegrateResult } from './worktree.ts';

/** gh may take up to two minutes per call; the episode makes three. */
const MERGE_LEASE_MINUTES = 10;

export const MERGE_OUTCOMES = [
  'merged',
  'already_merged',
  'waiting',
  'reland',
  'base-moved',
  'blocked',
  'error',
] as const;
export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

export interface MergeResult {
  /**
   * `merged`: this call merged the PR and GitHub confirmed it. `already_merged`: GitHub had
   * merged it before; the record is complete now. `waiting`: GitHub is still computing
   * mergeability; call again. `reland`: the PR conflicts, and `relandJob` replaces this job.
   * `base-moved`: the base moved after CI passed; it was merged into the branch and the job was
   * reopened, so `/factory <job>` verifies, pushes, and checks the new head before a merge.
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
  /**
   * The repository's readiness grade, shown next to the opt-in as advice (set by `mergeOptIn`).
   * Nothing that merges reads it.
   */
  grade?: ReadinessGrade | null;
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

/** `orch factory config merge <action>`: the opt-in, with the readiness grade beside it. */
export function mergeOptIn(
  store: Store,
  path: string,
  action: 'enable' | 'disable' | 'status',
): MergeAuthorization {
  const auth =
    action === 'status'
      ? mergeAuthorization(store, path)
      : setMergeAuthorization(store, path, action === 'enable');
  return { ...auth, grade: gradedReadiness(path).grade };
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
    `on the current ${before.baseBranch}: this job's branch starts from ${before.branch ?? '?'}'s ` +
    `head; merge ${before.baseBranch} into it and resolve the conflicts, keeping the original scope.`;
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
  // Load-bearing order: the file list is read before the PR that `mergeDecision` judges, so it is
  // no newer than the head that must equal `ciHead` (else `head-changed`), and `mergePr`'s
  // --match-head-commit refuses a head that moves after that.
  const files = prFiles(job.prUrl, cwd);
  const pr = viewPr(job.prUrl, cwd);
  const step = mergeDecision(job, pr, {
    completion: completionFor(store, job),
    authorized: input.mode === 'dashboard' || mergeAuthorized(store, job.repo),
    isReland: predecessorsOf(store.db, job.id).length > 0,
    changesWorkflows: changesWorkflows(files, pr),
    byHuman: input.mode === 'dashboard',
    // GitHub's compare, never the local clone (decision 2026-11-24-merge-requires-current-base).
    baseContained:
      job.ciHead === null ? null : baseContains(job.prUrl, job.baseBranch, job.ciHead, cwd),
    baseReopens: baseReopens(store.db, job.id),
  });
  return { pr, step };
}

/** GitHub's file list for the PR, or null when GitHub could not give one. */
function prFiles(url: string, cwd: string): GhPrFile[] | null {
  try {
    return listPrFiles(url, cwd);
  } catch (err) {
    if (err instanceof ToolError) return null;
    throw err;
  }
}

/**
 * Whether the PR touches `.github/workflows/` (added, edited, deleted, or renamed; renames count
 * both sides), from GitHub's file list for it, never from the local clone, which anything that can
 * write `.git` can make lie (decision 2026-11-22-workflow-changes-need-a-human-merge). True (fail
 * closed) when GitHub gave no list, or the list is not provably complete: its length must equal
 * the PR's `changedFiles` (GitHub caps the list at 3000 files).
 */
function changesWorkflows(files: GhPrFile[] | null, pr: GhPr): boolean {
  if (files === null || pr.changedFiles === null || files.length !== pr.changedFiles) return true;
  return touchesWorkflows(
    files.flatMap((f) =>
      f.previousFilename === null ? [f.filename] : [f.filename, f.previousFilename],
    ),
  );
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

/**
 * After a verified merge is recorded, remove the job's worktree the way `orch worktree remove`
 * does (refused when dirty; the branch is kept). The merge never fails because of it: any error
 * is recorded as `worktree.kept`. One sentence (with a leading space); empty without a worktree.
 */
function cleanUp(store: Store, job: Job, token: string): string {
  const path = job.worktreePath;
  if (!path) return '';
  try {
    dropWorktree(store, job.id, { token });
    return ` Removed the worktree ${path}.`;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    recordEvent(store, job.id, { token }, 'worktree.kept', { path, reason: why });
    return ` Kept the worktree ${path}: ${why.replace(/\.$/, '')}.`;
  }
}

/** Replace the conflicting job with a re-land job, as the holder of `token`. */
function reland(
  store: Store,
  job: Job,
  pr: GhPr,
  why: string,
  input: MergeInput,
  token: string,
): MergeResult {
  observePr(store, job.id, pr, { token });
  try {
    const created = relandJob(store, job, token, input.session);
    return result(job, pr, {
      outcome: 'reland',
      relandJob: created.id,
      reason:
        `${why}. Created ${created.id} to re-land the work; ${job.id} is superseded and ` +
        `its PR must not merge. Run /factory ${created.id}, then merge that job.`,
    });
  } catch (err) {
    if (!(err instanceof ValidationError) && !(err instanceof WorkflowError)) throw err;
    return result(job, pr, {
      outcome: 'blocked',
      code: 'reland-refused',
      reason: `${why}, and no re-land job could be created: ${err.message}`,
    });
  }
}

/**
 * The base moved after CI passed: merge it into the job's branch with `integrateBase` while the job
 * is still completed, and only once a merge commit exists reopen the job into pr, so that commit is
 * verified, pushed, and checked before a later merge (decision 2026-11-24-merge-requires-current-base).
 * A conflict re-lands; anything else leaves the job completed.
 */
function baseMoved(
  store: Store,
  job: Job,
  pr: GhPr,
  why: string,
  input: MergeInput,
  token: string,
): MergeResult {
  const refused = (detail: string) =>
    result(job, pr, {
      outcome: 'blocked',
      code: 'reopen-refused',
      reason: `${why}, and the job cannot be reopened: ${detail}`,
    });
  const other = siblingOnTicket(store.db, job);
  if (other !== null) return refused(`${other} is already working on its ticket`);
  let integrated: IntegrateResult;
  try {
    integrated = integrateBase(store, job.id, { token });
  } catch (err) {
    if (err instanceof MergeConflictError) {
      const conflict = `${why}, and merging it into ${job.branch ?? 'the branch'} conflicts in ${err.files.join(', ') || 'unknown files'}`;
      if (input.reland === false) {
        return result(job, pr, { outcome: 'blocked', code: 'conflict', reason: conflict });
      }
      return reland(store, job, pr, conflict, input, token);
    }
    if (err instanceof ValidationError || err instanceof ToolError) return refused(err.message);
    throw err;
  }
  const { integration } = integrated;
  if (integration.status !== 'merged' || integration.resultHead === null) {
    return result(job, pr, {
      outcome: 'error',
      reason:
        `${why}, but ${integration.baseRef} fetched from origin is already in the branch ` +
        `(integration ${integration.status}); GitHub and origin disagree, so run the command again`,
    });
  }
  const mergeHead = integration.resultHead;
  try {
    reopenJob(store, job.id, { token }, { reason: why, mergeHead, baseSha: integration.baseSha });
  } catch (err) {
    if (!(err instanceof WorkflowError)) throw err;
    return refused(err.message);
  }
  const material = integration.material ?? [];
  if (material.length > 0) {
    transitionJob(store, job.id, 'rework', {
      token,
      reason: `merge ${short(mergeHead)} edited ${material.join(', ')} beyond either parent`,
      integration: true,
    });
  }
  const next =
    job.ticketId === null
      ? `/factory ${job.id}`
      : `orch do ${ticketKey(job.ticketId)} or /factory ${job.id}`;
  return result(job, pr, {
    outcome: 'base-moved',
    reason:
      `${why}: merged ${integration.baseRef} into ${job.branch ?? 'the branch'} ` +
      `(merge commit ${short(mergeHead)}) and reopened ${job.id} in ` +
      `${material.length > 0 ? 'build, since the merge edited files' : 'pr'}; ${next} ` +
      'verifies, pushes, and checks it, then merges at the new head.',
  });
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
      reason: mergedText(job, now, m, ticket) + (m.verified ? cleanUp(store, job, token) : ''),
    });
  };

  if (step.step === 'record') {
    if (pr.mergeCommit === null) return noCommit(job, pr);
    return record(pr, confirmed(pr, pr.mergeCommit, step), 'already_merged');
  }

  if (step.step === 'reland') return reland(store, job, pr, step.reason, input, token);
  if (step.step === 'base-moved') return baseMoved(store, job, pr, step.reason, input, token);

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
