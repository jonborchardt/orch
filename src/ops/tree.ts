/** The job's worktree as the gates see it: present, valid, with a HEAD; optionally clean. */
import { existsSync } from 'node:fs';

import { ValidationError } from '../core/errors.ts';
import { inspectWorktree, type WorktreeInfo } from '../git/worktree.ts';
import type { Job } from '../storage/schema.ts';

export type Tree = WorktreeInfo & { head: string };

/** The job's worktree, or null when it has none. Throws when it is recorded but unusable. */
export function worktreeOf(job: Job): Tree | null {
  if (!job.worktreePath) return null;
  const root = existsSync(job.repoPath) ? job.repoPath : job.worktreePath;
  const info = inspectWorktree(root, job.worktreePath, job.baseBranch);
  if (!info.exists) {
    throw new ValidationError(`Worktree ${job.worktreePath} is missing; run orch worktree create.`);
  }
  if (!info.isWorktree || !info.head) {
    throw new ValidationError(`${job.worktreePath} is not a usable worktree of ${job.repo}.`);
  }
  return { ...info, head: info.head };
}

export function requireClean(info: WorktreeInfo, what: string): void {
  if (info.dirty.length === 0) return;
  const list = info.dirty.slice(0, 5).join(', ') + (info.dirty.length > 5 ? ', ...' : '');
  throw new ValidationError(
    `Worktree has uncommitted changes (${list}); ${what} must describe a committed state.`,
  );
}
