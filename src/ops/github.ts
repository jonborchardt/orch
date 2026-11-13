/**
 * GitHub delivery operations for a job: push the branch, create or reuse a draft PR, observe
 * PR and CI state. Every mutation checks job ownership first and validates that the GitHub
 * repository and base branch match the job before anything is pushed or created.
 */
import { existsSync } from 'node:fs';

import { ValidationError } from '../core/errors.ts';
import type { CiStatus, PrState } from '../core/workflow.ts';
import { describeRepo } from '../git/repo.ts';
import { git } from '../git/run.ts';
import { inspectWorktree } from '../git/worktree.ts';
import {
  createDraftPr,
  type GhIssue,
  type GhPr,
  type GhRepo,
  listPrsForBranch,
  prWorkflowState,
  summarizeChecks,
  viewIssue,
  viewPr,
  viewRepo,
} from '../integrations/github.ts';
import type { Store } from '../storage/client.ts';
import { type Auth, authorize, getJob, recordCi, recordEvent, recordPr } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';

function requireWorktree(job: Job): { path: string; branch: string } {
  if (!job.worktreePath || !job.branch) {
    throw new ValidationError(`Job ${job.id} has no worktree; run orch worktree create first.`);
  }
  if (!existsSync(job.worktreePath)) {
    throw new ValidationError(`Worktree ${job.worktreePath} is missing.`);
  }
  return { path: job.worktreePath, branch: job.branch };
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

/** `git push --set-upstream origin <branch>`; never force. */
export function pushBranch(store: Store, id: string, auth: Auth): PushResult {
  const job = authorize(store, id, auth);
  const { path, branch } = requireWorktree(job);
  const info = inspectWorktree(job.repoPath, path, job.baseBranch);
  if (info.branch !== branch) {
    throw new ValidationError(
      `Worktree is on ${info.branch ?? '(detached)'} but the job branch is ${branch}; refusing to push.`,
    );
  }
  const head = info.head ?? git(path, 'rev-parse', 'HEAD');
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
  const { path, branch } = requireWorktree(job);
  if (!existsSync(input.bodyFile))
    throw new ValidationError(`Body file not found: ${input.bodyFile}`);
  resolveRepo(job, path);
  if (!remoteHead(path, job.baseBranch)) {
    throw new ValidationError(`Base branch ${job.baseBranch} does not exist on origin.`);
  }
  const head = git(path, 'rev-parse', 'HEAD');
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
  const ciStatus = summarizeChecks(pr.checks);
  const updated = recordCi(store, id, { token: input.token, ciStatus });
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

/** Fetch PR state and checks. With a token, the observation is stored on the job. */
export function prStatus(store: Store, id: string, auth: Partial<Auth> = {}): PrStatusResult {
  const job = getJob(store.db, id);
  if (!job.prUrl) throw new ValidationError(`Job ${id} has no PR recorded.`);
  const cwd = job.worktreePath && existsSync(job.worktreePath) ? job.worktreePath : job.repoPath;
  const pr = viewPr(job.prUrl, cwd);
  const ciStatus = summarizeChecks(pr.checks);
  const state = prWorkflowState(pr);
  if (auth.token) {
    const updated = recordCi(store, id, {
      token: auth.token,
      expectRevision: auth.expectRevision,
      ciStatus,
      prState: state,
    });
    return { job: updated, pr, ciStatus, prState: state, recorded: true };
  }
  return { job, pr, ciStatus, prState: state, recorded: false };
}
