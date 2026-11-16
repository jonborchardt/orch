/**
 * GitHub delivery operations for a job: push the branch, create or reuse a draft PR, observe
 * PR and CI state, and mark the PR ready once CI completes the job. Every mutation checks job
 * ownership first and validates that the GitHub repository and base branch match the job before
 * anything is pushed or created.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CI_GRACE_POLLS,
  CI_MAX_RERUNS,
  type CiCheck,
  type CiEvaluation,
  ciStatusOf,
  evaluateChecks,
  RERUNNABLE,
  waitSeconds,
} from '../core/ci.ts';
import { ValidationError } from '../core/errors.ts';
import { jobArtifactDir } from '../core/paths.ts';
import type { CiStatus, PrState } from '../core/workflow.ts';
import { describeRepo } from '../git/repo.ts';
import { git } from '../git/run.ts';
import {
  actionsJobLog,
  actionsJobRunId,
  createDraftPr,
  type GhIssue,
  type GhPr,
  type GhRepo,
  listChecksFor,
  listPrsForBranch,
  markPrReady,
  prWorkflowState,
  requiredChecksFor,
  rerunFailedJobs,
  summarizeChecks,
  viewIssue,
  viewPr,
  viewRepo,
} from '../integrations/github.ts';
import type { Store } from '../storage/client.ts';
import { listEvents } from '../storage/events.ts';
import {
  type Auth,
  authorize,
  getJob,
  recordCi,
  recordEvent,
  recordPr,
  recordPrReady,
  recordPrState,
  transitionJob,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { completeCi, requireDeliverable } from './gates.ts';
import { type Tree, worktreeOf } from './tree.ts';
import { cap } from './verify.ts';

/** The job's worktree, inspected once (worktreeOf checks that the job branch is checked out). */
function requireWorktree(job: Job): Tree & { branch: string } {
  const tree = job.branch ? worktreeOf(job) : null;
  if (!tree || !job.branch) {
    throw new ValidationError(`Job ${job.id} has no worktree; run orch worktree create first.`);
  }
  return { ...tree, branch: job.branch };
}

/** The GitHub repository for a job, checked against the job's recorded identity. */
export function resolveRepo(job: Pick<Job, 'repo' | 'repoPath'>, cwd = job.repoPath): GhRepo {
  const gh = viewRepo(cwd);
  if (gh.identity !== job.repo) {
    throw new ValidationError(
      `GitHub reports ${gh.identity} for ${cwd}; job belongs to ${job.repo}.`,
    );
  }
  return gh;
}

export function issue(ref: string, cwd: string): GhIssue {
  const repo = describeRepo(cwd);
  const m = /^github\.com\/([^/]+\/[^/]+)$/.exec(repo.identity);
  return viewIssue(ref, repo.root, m?.[1]);
}

/** Remote SHA of `branch` on origin, or undefined when it is not there. */
function remoteHead(cwd: string, branch: string): string | undefined {
  const out = git(cwd, 'ls-remote', '--heads', 'origin', branch);
  return out ? out.split(/\s+/)[0] : undefined;
}

export interface PushResult {
  job: Job;
  branch: string;
  head: string;
  /** False when the remote already had this commit. */
  pushed: boolean;
}

/**
 * Only approved, verified code leaves the machine: pushing and PR creation happen in the pr stage,
 * and the delivery gate (approval, clean base merges only, verified HEAD, authorized policy)
 * holds for this exact HEAD.
 */
function requireApprovedHead(store: Store, job: Job, tree: Tree): void {
  if (job.stage !== 'pr') {
    throw new ValidationError(`Pushing is allowed in the pr stage only (job is in ${job.stage}).`);
  }
  requireDeliverable(store, job, tree, 'delivering');
}

/** `git push --set-upstream origin <branch>`; never force, never the base branch. */
export function pushBranch(store: Store, id: string, auth: Auth): PushResult {
  const job = authorize(store, id, auth);
  const tree = requireWorktree(job);
  const { path, branch, head } = tree;
  if (branch === job.baseBranch) {
    throw new ValidationError(`Job branch equals the base branch ${branch}; refusing to push.`);
  }
  requireApprovedHead(store, job, tree);
  if (remoteHead(path, branch) === head) {
    return { job, branch, head, pushed: false };
  }
  git(path, 'push', '--set-upstream', 'origin', branch);
  const updated = recordEvent(store, id, auth, 'branch.pushed', { branch, head });
  return { job: updated, branch, head, pushed: true };
}

export interface PrResult {
  job: Job;
  pr: GhPr;
  created: boolean;
  ciStatus: CiStatus;
}

export interface EnsurePrInput extends Auth {
  title?: string | undefined;
  bodyFile: string;
}

/**
 * Create a draft PR for the job branch, or reuse the open/merged one that already exists.
 * Requires the job to be in the `pr` stage, the branch to be pushed and current, the GitHub
 * repository to match the job, and the base branch to exist on origin.
 */
export function ensureDraftPr(store: Store, id: string, input: EnsurePrInput): PrResult {
  const job = authorize(store, id, input);
  if (job.stage !== 'pr') {
    throw new ValidationError(
      `A draft PR can only be created in the pr stage (job is in ${job.stage}).`,
    );
  }
  const tree = requireWorktree(job);
  const { path, branch, head } = tree;
  if (!existsSync(input.bodyFile))
    throw new ValidationError(`Body file not found: ${input.bodyFile}`);
  resolveRepo(job, path);
  if (!remoteHead(path, job.baseBranch)) {
    throw new ValidationError(`Base branch ${job.baseBranch} does not exist on origin.`);
  }
  requireApprovedHead(store, job, tree);
  const remote = remoteHead(path, branch);
  if (!remote) throw new ValidationError(`Branch ${branch} is not pushed; run orch gh push first.`);
  if (remote !== head) {
    throw new ValidationError(
      `origin/${branch} is at ${remote.slice(0, 7)} but HEAD is ${head.slice(0, 7)}; push first.`,
    );
  }
  const existing = listPrsForBranch(branch, path)
    .filter((p) => p.baseRefName === job.baseBranch && p.state !== 'CLOSED')
    .sort((a, b) => b.number - a.number)[0];
  const pr =
    existing ??
    createDraftPr(
      {
        base: job.baseBranch,
        head: branch,
        title: input.title ?? job.title,
        bodyFile: input.bodyFile,
      },
      path,
    );
  const state: PrState = prWorkflowState(pr) ?? 'draft';
  recordPr(store, id, { token: input.token, url: pr.url, state });
  // The rollup from `gh pr view` is informational: only `orch gh ci` records a per-commit
  // verdict (ciHead), so the ci stage cannot complete on this observation alone.
  const ciStatus = summarizeChecks(pr.checks);
  const updated = recordCi(store, id, { token: input.token, ciStatus, head: null });
  return { job: updated, pr, created: existing === undefined, ciStatus };
}

export interface PrStatusResult {
  job: Job;
  pr: GhPr;
  ciStatus: CiStatus;
  prState: PrState | undefined;
  /** True when the observation was written to the job (requires the owner token). */
  recorded: boolean;
}

/**
 * Fetch PR state and checks. With a token, the observation is stored on the job; on a completed
 * job only the PR state is, so the verdict that completed it is never overwritten by a rollup.
 */
export function prStatus(store: Store, id: string, auth: Partial<Auth> = {}): PrStatusResult {
  const job = getJob(store.db, id);
  if (!job.prUrl) throw new ValidationError(`Job ${id} has no PR recorded.`);
  const cwd = job.worktreePath && existsSync(job.worktreePath) ? job.worktreePath : job.repoPath;
  const pr = viewPr(job.prUrl, cwd);
  const ciStatus = summarizeChecks(pr.checks);
  const state = prWorkflowState(pr);
  if (auth.token && job.status === 'completed') {
    // The completed verdict (ciHead, ciStatus) stays as recorded; only the PR's state is news.
    const updated = recordPrState(
      store,
      id,
      { token: auth.token, expectRevision: auth.expectRevision },
      { event: 'pr.observed', state, head: pr.headSha },
    );
    return { job: updated, pr, ciStatus, prState: state, recorded: true };
  }
  if (auth.token) {
    const updated = recordCi(store, id, {
      token: auth.token,
      expectRevision: auth.expectRevision,
      ciStatus,
      prState: state,
      head: null, // a rollup, not a per-commit verdict; `orch gh ci` must read the head again
    });
    return { job: updated, pr, ciStatus, prState: state, recorded: true };
  }
  return { job, pr, ciStatus, prState: state, recorded: false };
}

// ---------------------------------------------------------------------------------------------
// CI reconciliation: the ci stage's only source of truth.

export interface CiFailure {
  name: string;
  conclusion: string;
  url: string | null;
  /** Log saved under the artifact directory (relative path), when GitHub provided one. */
  log: string | null;
}

export interface CiReconcileResult {
  job: Job;
  pr: GhPr;
  /** PR head commit GitHub reported; the verdict is bound to it. */
  head: string;
  /** True when that commit is the worktree HEAD and origin/<branch>. */
  current: boolean;
  outcome: CiEvaluation['outcome'] | 'outdated' | 'closed';
  ciStatus: CiStatus;
  evaluation: CiEvaluation;
  failures: CiFailure[];
  /** Observations of this head so far, including this one. */
  polls: number;
  /** Re-runs requested for this head so far (bounded by CI_MAX_RERUNS), including this call's. */
  reruns: number;
  /** For `wait`: seconds the coordinator should sleep before the next `orch gh ci`. */
  waitSeconds: number | null;
  /** What this call did to the workflow. */
  action: 'wait' | 'complete' | 'rework' | 'escalate' | 'exhausted';
  reason: string;
  /**
   * For `complete`: whether orch took the draft PR out of draft (`marked`), found it already
   * ready or merged (`already`), or `gh pr ready` failed (`failed`, see readyError). Null otherwise.
   */
  ready: 'marked' | 'already' | 'failed' | null;
  readyError: string | null;
}

/** Reconciliations already recorded for `head` (`pr status` observations carry no outcome). */
function isObservation(
  e: { type: string; payload: Record<string, unknown> },
  head: string,
): boolean {
  return (
    e.type === 'ci.observed' && e.payload['head'] === head && e.payload['outcome'] !== undefined
  );
}

function pollsFor(store: Store, id: string, head: string): number {
  return listEvents(store.db, id, 1000).filter((e) => isObservation(e, head)).length;
}

interface Reruns {
  /** Re-runs GitHub accepted for this head. */
  requested: number;
  /** Check-run ids those re-runs replaced; seeing them again means GitHub has not caught up. */
  replaced: Set<number>;
  /** Observations recorded since the latest accepted re-run. */
  observedSince: number;
}

function rerunsFor(store: Store, id: string, head: string): Reruns {
  const events = listEvents(store.db, id, 1000);
  const accepted = events.filter(
    (e) => e.type === 'ci.rerun' && e.payload['head'] === head && e.payload['ok'] === true,
  );
  const last = accepted.at(-1);
  return {
    requested: accepted.length,
    replaced: new Set(accepted.flatMap((e) => e.payload['checkRunIds'] as number[])),
    observedSince: last ? events.filter((e) => e.id > last.id && isObservation(e, head)).length : 0,
  };
}

/** Ask GitHub to re-run the failed jobs of every workflow run behind `checks`. */
function requestRerun(
  nameWithOwner: string,
  checks: CiCheck[],
  cwd: string,
): { runs: number[]; error: string | null } {
  const runs: number[] = [];
  for (const c of checks) {
    if (c.jobId === null) continue;
    const run = actionsJobRunId(nameWithOwner, c.jobId, cwd);
    if (run === null) {
      return { runs, error: `GitHub did not report the workflow run of check ${c.name}` };
    }
    if (!runs.includes(run)) runs.push(run);
  }
  for (const run of runs) {
    const error = rerunFailedJobs(nameWithOwner, run, cwd);
    if (error !== null) return { runs, error: `gh run rerun ${String(run)} failed: ${error}` };
  }
  return { runs, error: null };
}

/** Save each failed required check's log under <artifactDir>/ci/<sha7>/; never throws. */
function collectDiagnostics(
  store: Store,
  job: Job,
  nameWithOwner: string,
  head: string,
  checks: CiCheck[],
  cwd: string,
): CiFailure[] {
  const dir = join('ci', head.slice(0, 7));
  const abs = join(jobArtifactDir(job.id, store.paths), dir);
  return checks.map((c) => {
    let log: string | null = null;
    if (c.jobId !== null) {
      const text = actionsJobLog(nameWithOwner, c.jobId, cwd);
      if (text !== null) {
        const file = `${c.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'check'}.log`;
        mkdirSync(abs, { recursive: true });
        writeFileSync(join(abs, file), cap(text).text);
        log = `${dir.split('\\').join('/')}/${file}`;
      }
    }
    return { name: c.name, conclusion: c.conclusion, url: c.url, log };
  });
}

/**
 * Read GitHub's verdict for the PR head and act on it. Runs only while the ci stage is running
 * and needs the owner token. The result is recorded with the head SHA it describes; a verdict
 * for any other commit (an outdated PR head, a branch pushed outside the job) never completes
 * the job. A required check that failed, timed out, was cancelled, or never started is first
 * re-run once per head (`gh run rerun --failed`, recorded as `ci.rerun`), once every other
 * required check has finished; the re-run touches no source and spends no repair. Only a second
 * verdict for the same commit acts: failing required checks collect diagnostics and send the job
 * back to build through `rework`, which is bounded by `maxCiRepairs` and escalates when
 * exhausted; checks that still did not run (cancelled, startup failure, never reported) and a PR
 * with no checks at all are escalated, not counted as repairs. Pending checks record only the
 * observation with the seconds to wait: the caller sleeps and calls again, or resumes later.
 */
export function reconcileCi(store: Store, id: string, auth: Auth): CiReconcileResult {
  const job = authorize(store, id, auth);
  if (job.stage !== 'ci' || job.status !== 'running') {
    throw new ValidationError(
      `CI is reconciled while the ci stage is running (job is in ${job.stage}/${job.status}).`,
    );
  }
  if (!job.prUrl) throw new ValidationError(`Job ${id} has no PR recorded.`);
  const tree = requireWorktree(job);
  const repo = resolveRepo(job, tree.path);
  const pr = viewPr(job.prUrl, tree.path);
  const head = pr.headSha;
  if (!head) throw new ValidationError(`GitHub did not report a head commit for ${job.prUrl}.`);
  const prState = prWorkflowState(pr);
  const remote = remoteHead(tree.path, tree.branch);
  // The PR must be the job's own: from the job branch into the job's base.
  const foreign =
    pr.headRefName !== tree.branch || pr.baseRefName !== job.baseBranch
      ? `${pr.url} is ${pr.headRefName} -> ${pr.baseRefName}, not the job's ${tree.branch} -> ${job.baseBranch}`
      : null;
  const current = foreign === null && head === tree.head && remote === tree.head;
  const polls = pollsFor(store, id, head) + 1;
  const configured = requiredChecksFor(repo.nameWithOwner, job.baseBranch, tree.path);
  const checks = listChecksFor(repo.nameWithOwner, head, tree.path);
  const evaluation = evaluateChecks(checks, configured, polls);

  let outcome: CiReconcileResult['outcome'] = evaluation.outcome;
  let action: CiReconcileResult['action'] = 'wait';
  let reason = evaluation.reason;
  let failures: CiFailure[] = [];
  const tok = { token: auth.token };
  const reruns = rerunsFor(store, id, head);
  let rerun: { runs: number[]; checks: CiCheck[]; error: string | null } | null = null;
  const after = reruns.requested > 0 ? ` (after ${String(reruns.requested)} re-run)` : '';

  if (pr.state === 'CLOSED') {
    outcome = 'closed';
    action = 'escalate';
    reason = `${pr.url} was closed without merging; a human reopens it (then resume --to ci) or cancels the job`;
  } else if (foreign !== null) {
    outcome = 'outdated';
    action = 'escalate';
    reason = `${foreign}. A human resumes --to pr so orch gh pr create records the job's own PR, or cancels the job.`;
  } else if (!current) {
    outcome = 'outdated';
    action = 'escalate';
    reason =
      `PR head is ${head.slice(0, 7)}, origin/${tree.branch} is ${remote?.slice(0, 7) ?? 'absent'}, ` +
      `worktree HEAD is ${tree.head.slice(0, 7)}: the branch changed outside the job. ` +
      'A human reconciles it (resume --to pr re-pushes an approved HEAD; resume --to ci re-reads checks).';
  } else {
    // Required checks that did not pass, and whether re-running their workflow runs could help.
    const culprits = [...evaluation.failed, ...evaluation.infrastructure];
    const names = culprits.map((c) => c.name).join(', ');
    const stale =
      culprits.length > 0 && culprits.every((c) => c.id !== null && reruns.replaced.has(c.id));
    const rerunnable =
      culprits.length > 0 &&
      evaluation.missing.length === 0 &&
      culprits.every((c) => c.jobId !== null && RERUNNABLE.has(c.conclusion.toLowerCase()));
    if (stale && reruns.observedSince < CI_GRACE_POLLS) {
      // The re-run was accepted but GitHub still reports the runs it replaces: not a new verdict.
      outcome = 'pending';
      reason = `re-run requested for ${names}; GitHub has not reported the new attempt yet`;
    } else if (rerunnable && reruns.requested < CI_MAX_RERUNS) {
      if (evaluation.pending.length > 0) {
        // A run can only be re-run once it has finished; other required checks are still going.
        outcome = 'pending';
        reason = `${names} did not pass; waiting for ${evaluation.pending.join(', ')} to finish before re-running`;
      } else {
        rerun = { ...requestRerun(repo.nameWithOwner, culprits, tree.path), checks: culprits };
        if (rerun.error === null) {
          outcome = 'pending';
          reason =
            `${names} did not pass (${culprits.map((c) => c.conclusion).join(', ')}); re-run ` +
            `${String(reruns.requested + 1)} of ${String(CI_MAX_RERUNS)} requested for workflow run(s) ` +
            `${rerun.runs.join(', ')}. A second failure of this commit is treated as a defect.`;
        }
      }
    }
    if (outcome === 'failing') {
      failures = collectDiagnostics(
        store,
        job,
        repo.nameWithOwner,
        head,
        evaluation.failed,
        tree.path,
      );
      const logs = failures.flatMap((f) => (f.log ? [f.log] : []));
      action = job.ciRepairs >= job.maxCiRepairs ? 'exhausted' : 'rework';
      reason =
        `CI failed for ${head.slice(0, 7)}: ${evaluation.failed.map((c) => c.name).join(', ')}${after}` +
        (logs.length ? `; logs under the artifact directory: ${logs.join(', ')}` : '');
    } else if (outcome === 'infrastructure' || outcome === 'none') {
      action = 'escalate';
      reason =
        outcome === 'none'
          ? `${evaluation.reason}; no required checks are configured for ${job.baseBranch}. ` +
            'A human adds CI and resumes --to ci, or accepts delivery without CI with resume --to completed.'
          : `${evaluation.reason}${after}. Not a code defect: a human re-runs the workflow or fixes CI, then resumes --to ci.`;
    } else if (outcome === 'passing') {
      action = 'complete';
    }
    if (rerun?.error) reason += ` Re-run could not be requested: ${rerun.error}.`;
  }
  // The persisted rollup describes the checks; a closed or outdated PR still records what they said.
  const ciStatus = ciStatusOf(
    outcome === 'closed' || outcome === 'outdated' ? evaluation.outcome : outcome,
  );

  recordCi(store, id, {
    ...tok,
    ciStatus,
    prState,
    head,
    detail: {
      current,
      outcome,
      polls,
      required: evaluation.required,
      configured: evaluation.configured,
      checks: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
      failures,
      reason,
    },
  });
  if (rerun) {
    recordEvent(store, id, tok, 'ci.rerun', {
      head,
      attempt: reruns.requested + 1,
      runs: rerun.runs,
      checks: rerun.checks.map((c) => c.name),
      checkRunIds: rerun.checks.map((c) => c.id),
      ok: rerun.error === null,
      error: rerun.error,
    });
  }
  let updated: Job;
  let ready: CiReconcileResult['ready'] = null;
  let readyError: string | null = null;
  if (action === 'rework' || action === 'exhausted') {
    updated = transitionJob(store, id, 'rework', { ...tok, reason });
  } else if (action === 'escalate') {
    updated = transitionJob(store, id, 'escalate', { ...tok, reason });
  } else if (action === 'complete') {
    // The read and the completion are one operation: no stored verdict is ever reused.
    // A draft still needs its ready write, so the lease is held for it; that write releases it.
    updated = completeCi(store, id, { ...tok, holdLease: prState === 'draft' });
    // Strictly after the verdict commits: a failed or interrupted ready never undoes it, and is
    // not retried (a human runs gh pr ready; the board still shows the PR as draft).
    if (prState === 'draft') {
      readyError = markPrReady(pr.url, tree.path);
      updated = recordPrReady(store, id, { ...tok, head, error: readyError });
      ready = readyError === null ? 'marked' : 'failed';
    } else {
      ready = 'already';
    }
  } else {
    updated = getJob(store.db, id);
  }
  return {
    job: updated,
    pr,
    head,
    current,
    outcome,
    ciStatus,
    evaluation,
    failures,
    polls,
    reruns: reruns.requested + (rerun?.error === null ? 1 : 0),
    waitSeconds: action === 'wait' ? waitSeconds(polls) : null,
    action,
    reason,
    ready,
    readyError,
  };
}
