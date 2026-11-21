/**
 * What the Git tab says about a job whose PR is recorded merged. After a merge the worktree's
 * comparison with the current base is empty (or, after a squash, still "ahead"), so the job's
 * history comes from recorded evidence instead: the merged head from the PR events and the merge
 * base recorded with that head's baseline verification run. Read-only.
 */
import { type Commit, changesBetween, commitsBetween } from '../git/worktree.ts';
import type { Store } from '../storage/client.ts';
import { eventsOfTypes } from '../storage/events.ts';
import { mergeEvidence } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { listRuns } from '../storage/verification.ts';

export interface MergeView {
  base: string;
  prUrl: string | null;
  /** GitHub's PR head at merge time, from `pr.merged` (ok) or `pr.observed` (merged); null if unknown. */
  head: string | null;
  /** The commit GitHub created on the base, from the recorded merge evidence; null if unknown. */
  mergeCommit: string | null;
  /** Whether the merged head was the CI-verified one; null when no evidence was recorded. */
  verified: boolean | null;
  /** Whether a head and its recorded merge base resolved, so `commits` and `changedFiles` are the job's. */
  historyKnown: boolean;
  commits: Commit[];
  changedFiles: string[];
  /** Worktree commits beyond the merged head; null without a known head or a worktree. */
  outstanding: Commit[] | null;
}

/** Only full or abbreviated hex SHAs reach Git as revisions. */
const SHA = /^[0-9a-f]{7,64}$/i;
const sha = (v: unknown): string | null => (typeof v === 'string' && SHA.test(v) ? v : null);

function mergedHead(store: Store, id: string): string | null {
  const events = eventsOfTypes(store.db, id, ['pr.merged', 'pr.observed']);
  const merged = events.find((e) => e.type === 'pr.merged' && e.payload['ok'] === true);
  const observed = events.find((e) => e.type === 'pr.observed' && e.payload['state'] === 'merged');
  return sha(merged?.payload['head']) ?? sha(observed?.payload['head']);
}

/** Null unless `job.prState` is `merged`. `worktree` is the inspected worktree, if one exists. */
export function mergeView(
  store: Store,
  job: Job,
  worktree: { path: string; head: string | null } | null,
): MergeView | null {
  if (job.prState !== 'merged') return null;
  const head = mergedHead(store, job.id);
  // History may fall back to the CI head; outstanding work never does (see the spec of todo 0017).
  const historyHead = head ?? sha(job.ciHead);
  const run = historyHead
    ? listRuns(store.db, job.id).find(
        (r) => r.head === historyHead && r.policySource === 'baseline',
      )
    : undefined;
  const mergeBase = sha(run?.policyHead);
  const commits =
    historyHead && mergeBase ? commitsBetween(job.repoPath, mergeBase, historyHead) : null;
  const changes =
    historyHead && mergeBase ? changesBetween(job.repoPath, mergeBase, historyHead) : null;
  const wtHead = sha(worktree?.head);
  const evidence = mergeEvidence(store.db, job.id);
  return {
    base: job.baseBranch,
    prUrl: job.prUrl,
    head,
    mergeCommit: sha(evidence?.['mergeCommit']),
    verified: typeof evidence?.['verified'] === 'boolean' ? evidence['verified'] : null,
    historyKnown: commits !== null && changes !== null,
    commits: commits && changes ? commits : [],
    changedFiles: commits && changes ? changes.map((c) => c.path) : [],
    outstanding: head && worktree && wtHead ? commitsBetween(worktree.path, head, wtHead) : null,
  };
}
