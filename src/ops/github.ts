/**
 * GitHub delivery operations for a job: push the branch, create or reuse a draft PR, observe
 * PR and CI state. Every mutation checks job ownership first and validates that the GitHub
 * repository and base branch match the job before anything is pushed or created.
 */
import { existsSync } from 'node:fs';

import { ValidationError } from '../core/errors.ts';
import type { CiStatus, PrState } from '../core/workflow.ts';
import { baseRef, describeRepo } from '../git/repo.ts';
import { git, tryGit } from '../git/run.ts';
import { editedMerges } from '../git/worktree.ts';
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
import { findArtifact } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { type Auth, authorize, getJob, recordCi, recordEvent, recordPr } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { jobCheckout } from './repo.ts';
import { requireClean, type Tree, worktreeOf } from './tree.ts';
import { effectivePolicy, verificationStatus } from './verify.ts';

/** The job's worktree, inspected once, with the job branch checked out. */
function requireWorktree(job: Job): Tree & { branch: string } {
  const tree = job.branch ? worktreeOf(job) : null;
  if (!tree || !job.branch) {
    throw new ValidationError(`Job ${job.id} has no worktree; run orch worktree create first.`);
  }
  if (tree.branch !== job.branch) {
    throw new ValidationError(
      `Worktree is on ${tree.branch ?? '(detached)'} but the job branch is ${job.branch}; refusing to push.`,
    );
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
 * Only approved, verified code leaves the machine: the job must be in the pr stage, decision.md
 * must be APPROVE recorded against a commit, every commit since then that is not already on the
 * base must be a merge whose result matches one of its parents (a clean base integration, no
 * edits inside the merge), the verification policy must not have drifted without a human, and the
 * latest verification run must be valid for this exact HEAD.
 */
function requireApprovedHead(store: Store, job: Job, tree: Tree): void {
  const { path, head } = tree;
  if (job.stage !== 'pr' && job.stage !== 'completed') {
    throw new ValidationError(`Pushing is allowed in the pr stage only (job is in ${job.stage}).`);
  }
  const decision = findArtifact(store.db, job.id, 'decision.md');
  if (decision?.marker !== 'approve' || !decision.head) {
    throw new ValidationError('No DECISION: APPROVE recorded against a commit; refusing to push.');
  }
  if (decision.head !== head) {
    const base = baseRef(path, job.baseBranch);
    const unreviewed = tryGit(
      path,
      'rev-list',
      '--no-merges',
      `${decision.head}..${head}`,
      ...(base ? [`^${base}`] : []),
    );
    if (unreviewed === undefined || unreviewed !== '') {
      throw new ValidationError(
        `HEAD ${head.slice(0, 7)} has commits that were not approved (approved: ${decision.head.slice(0, 7)}); ` +
          'only base integration merges may follow an approval. Return the job to review.',
      );
    }
    const edited = editedMerges(path, decision.head, head);
    if (edited.length > 0) {
      const list = edited.map((m) => `${m.sha.slice(0, 7)}: ${m.files.join(', ')}`).join('; ');
      throw new ValidationError(
        `Merge commit(s) since the approval contain edits that match neither parent (${list}); ` +
          'conflict resolutions are new code. Rework, re-review, and re-approve first.',
      );
    }
  }
  requireClean(tree, 'refusing to deliver.');
  const eff = effectivePolicy(job, tree);
  if (eff.diff) {
    throw new ValidationError(
      'The worktree changes the verification policy without a recorded human authorization; refusing to deliver.',
    );
  }
  const status = verificationStatus(store, job, tree, eff);
  if (!status.valid) {
    throw new ValidationError(
      `No valid verification run for HEAD ${head.slice(0, 7)}: ${status.reason ?? 'none'}. Run orch verify ${job.id} first.`,
    );
  }
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
  // A remote added or changed since the job was created is reconciled before GitHub is consulted.
  const checked = existsSync(job.repoPath) ? jobCheckout(store, job, input) : { job, auth: input };
  input = { ...input, expectRevision: checked.auth.expectRevision };
  resolveRepo(checked.job, path);
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
