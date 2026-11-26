/**
 * Which local repository a job belongs to.
 *
 * A job records two things about its repository. `repoPath` is the checkout it was started from;
 * that checkout's canonical Git common directory (shared by the checkout and every linked
 * worktree) is the job's stable local identity, and it does not change when `origin` is added,
 * removed, or re-pointed. `repo` is the remote identity (normalized `origin` URL, else the
 * directory name): what the dashboard groups by, what PR delivery checks against GitHub, and how
 * another clone of the same remote is recognised. The remote identity follows the remote; the
 * local identity never moves.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { ValidationError } from '../core/errors.ts';
import type { Stage, Status } from '../core/workflow.ts';
import {
  checkoutIdentity,
  commonGitDir,
  describeRepo,
  primaryCheckout,
  type RepoInfo,
} from '../git/repo.ts';
import type { Store } from '../storage/client.ts';
import { type Auth, listJobs, setRepo } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';

/** Canonical common Git directory of `path`, or undefined when it is not inside a repository. */
export function localRepoKey(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return commonGitDir(path);
  } catch {
    return undefined;
  }
}

/** True when `path` is inside the job's own repository: its checkout or any linked worktree. */
export function sameLocalRepo(job: Pick<Job, 'repoPath'>, path: string): boolean {
  const key = localRepoKey(path);
  return key !== undefined && key === localRepoKey(job.repoPath);
}

export interface JobRepository {
  /** The primary checkout's view: root, identity, current branch. */
  repo: RepoInfo;
  /** `base` when given, else the primary checkout's current branch. */
  base: string;
}

/**
 * The repository a new job created from `path` belongs to. A linked worktree (a session's own)
 * resolves to its primary checkout, so the job records that checkout and its branch as the base,
 * and the worktree stays free to be adopted. A primary checkout resolves to itself.
 */
export function jobRepository(path: string, base?: string): JobRepository {
  const here = describeRepo(path);
  const repo =
    checkoutIdentity(here.root)?.kind === 'worktree'
      ? describeRepo(primaryCheckout(here.root))
      : here;
  return { repo, base: base ?? repo.currentBranch };
}

export interface Checkout {
  job: Job;
  /** The checkout to run Git in (the job's recorded one unless another clone was named). */
  root: string;
  /** `auth` to continue with: the revision moves on when the identity was refreshed. */
  auth: Auth;
}

/**
 * The checkout a job operates on: its recorded one, or `override` (`--repo`). The job's own
 * repository is recognised by its common directory, so a remote that was added or changed since
 * the job was created is reconciled (job.repo refreshed, `repo.repointed` recorded) instead of
 * refused, once `requireContinuity` has ruled out a replaced directory; the recorded checkout
 * stays the root even when a linked worktree was named. A different local repository is accepted
 * only as another clone of the same remote identity. `explicit` is the operator's `orch job repo`
 * confirmation. The caller has already authorized `auth`.
 */
export function jobCheckout(
  store: Store,
  job: Job,
  auth: Auth,
  override?: string,
  explicit = false,
): Checkout {
  const candidate = override ?? job.repoPath;
  if (!existsSync(candidate)) {
    throw new ValidationError(
      `Repository checkout ${candidate} does not exist. Pass --repo <path> to another clone of ${job.repo}.`,
    );
  }
  const info = describeRepo(candidate);
  if (override === undefined || sameLocalRepo(job, candidate)) {
    const root = override === undefined ? info.root : job.repoPath;
    if (info.identity === job.repo) return { job, root, auth };
    requireContinuity(job, info, explicit);
    const updated = setRepo(store, job.id, auth, { repo: info.identity, repoPath: job.repoPath });
    const next =
      auth.expectRevision === undefined ? auth : { ...auth, expectRevision: updated.revision };
    return { job: updated, root, auth: next };
  }
  if (info.remote !== undefined && info.remote === job.repo) return { job, root: info.root, auth };
  throw new ValidationError(mismatch(job, info));
}

/**
 * Nothing stored distinguishes a remote change from an unrelated repository placed at the recorded
 * path, so a new identity there is adopted only on evidence. The job's worktree on disk is the
 * evidence: it was created from the job's repository and still names its common directory, so the
 * checkout must share it. Without a worktree, only an operator can vouch (`orch job repo`).
 */
function requireContinuity(job: Job, info: RepoInfo, explicit: boolean): void {
  const found = `Repository at ${info.root} is ${info.identity}; job ${job.id} belongs to ${job.repo}`;
  if (job.worktreePath !== null && existsSync(job.worktreePath)) {
    const key = localRepoKey(job.worktreePath);
    if (key !== undefined && key === localRepoKey(info.root)) return;
    throw new ValidationError(
      `${found}, and its worktree ${job.worktreePath} ${
        key === undefined ? 'no longer resolves to any repository' : 'belongs to another repository'
      }. The recorded checkout ${job.repoPath} was replaced, not re-pointed; restore it.`,
    );
  }
  if (explicit) return;
  throw new ValidationError(
    `${found}, and has no worktree to prove the checkout is the same repository under a new ` +
      `remote. If it is, confirm with: orch job repo ${job.id} --token <t>.`,
  );
}

function mismatch(job: Job, info: RepoInfo): string {
  const recorded = existsSync(job.repoPath) ? 'a different repository' : 'missing';
  const why =
    info.remote === undefined || !job.repo.includes('/')
      ? `${job.repo} is a directory name (no remote when the job was created), so only that checkout or one of its worktrees can prove it is the same repository`
      : `another clone is accepted only when its origin is ${job.repo}`;
  return (
    `Repository at ${info.root} is ${info.identity}; job ${job.id} belongs to ${job.repo}, ` +
    `recorded at ${job.repoPath} (${recorded}). A job follows its own checkout and linked ` +
    `worktrees through remote changes; ${why}. Restore the recorded checkout, or pass --repo ` +
    `<path> inside it.`
  );
}

/**
 * The scope of one factory controller (decision 2026-11-25-one-controller-per-repository): which
 * repository it works on, and so which controller slot it takes. This file is the only place
 * that decides it, and the only place that compares two scopes.
 */
export interface RunnerScope {
  /** Names the slot's directory: a short hash of `name`. */
  key: string;
  /** The remote identity when the repository has one, else its canonical Git common directory. */
  name: string;
  /** The canonical Git common directory; null when only a remote identity is known. */
  commonDir: string | null;
}

const scopeOf = (name: string, commonDir: string | null): RunnerScope => ({
  key: createHash('sha256').update(name).digest('hex').slice(0, 16),
  name,
  commonDir,
});

/**
 * The controller scope of the repository containing `path`. Two clones of one remote, and a
 * checkout and its linked worktrees, share a key. A clone without `origin` next to a separate
 * clone with one are two scopes (different keys, different common directories): the queue filter
 * (`inRepositoryAt`) gives them different tickets, so their controllers never meet. One checkout
 * whose remote changed is still one scope, by its common directory (`scopesOverlap`).
 */
export function runnerScope(path: string): RunnerScope {
  const commonDir = localRepoKey(path);
  if (commonDir === undefined) {
    throw new ValidationError(`${path} is not inside a Git repository.`);
  }
  return scopeOf(describeRepo(path).remote ?? commonDir, commonDir);
}

/**
 * The controller scope of a ticket's repository (`orch do`): its recorded checkout when that
 * still is a repository, else its remote identity, which gives the key a clone with that origin
 * would. A ticket recorded under a directory name has nothing else to be found by.
 */
export function ticketRunnerScope(ticket: {
  key: string;
  repo: string;
  repoPath: string;
}): RunnerScope {
  if (localRepoKey(ticket.repoPath) !== undefined) return runnerScope(ticket.repoPath);
  if (ticket.repo.includes('/')) return scopeOf(ticket.repo, null);
  throw new ValidationError(
    `Ticket ${ticket.key} belongs to ${ticket.repo}, whose checkout ${ticket.repoPath} is ` +
      'missing or no longer a repository, and it has no remote identity to find another clone ' +
      'by. Restore the checkout, then run orch do again.',
  );
}

/**
 * Whether two controller slots could work on the same repository; null is the unscoped slot
 * ("every repository"), which overlaps everything. Equal keys are one slot. Equal common
 * directories are one checkout under two keys: its `origin` was added, removed, or re-pointed.
 */
export function scopesOverlap(
  a: Pick<RunnerScope, 'key' | 'commonDir'> | null,
  b: Pick<RunnerScope, 'key' | 'commonDir'> | null,
): boolean {
  if (a === null || b === null || a.key === b.key) return true;
  return a.commonDir !== null && a.commonDir === b.commonDir;
}

export interface JobFilter {
  /** A local path (its repository, any worktree) or a remote identity such as github.com/o/r. */
  repo?: string | undefined;
  status?: Status | undefined;
  stage?: Stage | undefined;
}

/**
 * Jobs matching the filter. A path finds the jobs of that local repository (by common directory,
 * so a stale stored identity still matches) plus, when it has a remote, jobs of other clones of
 * the same remote. A bare identity matches the stored identity exactly.
 */
export function findJobs(store: Store, filter: JobFilter): Job[] {
  const path = filter.repo !== undefined && existsSync(filter.repo) ? filter.repo : undefined;
  const jobs = listJobs(store.db, {
    repo: path === undefined ? filter.repo : undefined,
    status: filter.status,
    stage: filter.stage,
  });
  if (path === undefined) return jobs;
  return jobs.filter(inRepositoryAt(path));
}

/**
 * Predicate for rows (jobs, tickets) of the repository at `path`: recorded in that local
 * repository (by common directory, so a stale stored identity still matches) or, when it has a
 * remote, in another clone of the same remote.
 */
export function inRepositoryAt(path: string): (row: { repo: string; repoPath: string }) => boolean {
  const info = describeRepo(path);
  const key = localRepoKey(path);
  // ponytail: one git call per distinct recorded checkout; index a stored key if lists get long.
  const keys = new Map<string, string | undefined>();
  const keyOf = (p: string) => {
    if (!keys.has(p)) keys.set(p, localRepoKey(p));
    return keys.get(p);
  };
  return (row) =>
    (info.remote !== undefined && row.repo === info.remote) ||
    (key !== undefined && keyOf(row.repoPath) === key);
}
