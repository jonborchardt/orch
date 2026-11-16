/**
 * Human actions on a job from the dashboard (or any non-session tool). Each one is a short
 * ownership episode as session `dashboard`: claim, apply validated workflow transitions, release.
 * Nothing here wakes a Claude session; the result always says the job must be resumed.
 */
import { existsSync } from 'node:fs';

import { ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import {
  cannotAcceptDelivery,
  cannotMerge,
  cannotRefreshPr,
  type Completion,
  completionOf,
  now,
  type Stage,
  TERMINAL_STATUSES,
} from '../core/workflow.ts';
import { mergePr, prWorkflowState, viewPr } from '../integrations/github.ts';
import type { Store } from '../storage/client.ts';
import { policyFingerprint } from '../core/verification.ts';
import { latestEventsByJob } from '../storage/events.ts';
import {
  claimJob,
  getJob,
  recordPrState,
  releaseJob,
  setArchived,
  supersedeJob,
  transitionJob,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { authorizePolicy } from '../storage/verification.ts';
import { worktreeOf } from './tree.ts';
import { candidatePolicy } from './verify.ts';

export const DASHBOARD_ACTIONS = [
  'approve',
  'request-review',
  'request-rework',
  'accept-policy',
  'accept-delivery',
  'cancel',
  'archive',
  'unarchive',
  'merge',
  'refresh-pr',
] as const;
export type DashboardAction = (typeof DASHBOARD_ACTIONS)[number];
export const DASHBOARD_SESSION = 'dashboard';

export interface ActionInput {
  action: DashboardAction;
  reason?: string | undefined;
  /** Take the job from a session whose lease is still live. */
  force?: boolean | undefined;
  /** For `approve`: stage to return to (defaults to the stage the job was escalated from). */
  to?: Stage | undefined;
}

/** Job row minus the credential; the only shape that leaves the process. */
export function withoutToken(job: Job): Omit<Job, 'ownerToken'> {
  const copy: Partial<Job> = { ...job };
  delete copy.ownerToken;
  return copy as Omit<Job, 'ownerToken'>;
}

/**
 * Actions `dashboardAction` would not refuse outright in this state. The dashboard renders only
 * these; the server still re-checks every POST, so this is presentation, not authorization.
 */
export function allowedActions(
  job: Pick<
    Job,
    | 'status'
    | 'stage'
    | 'round'
    | 'returnStage'
    | 'prUrl'
    | 'ciHead'
    | 'ciStatus'
    | 'prState'
    | 'archivedAt'
  >,
  policyDrift: boolean,
  completion: Completion = null,
): DashboardAction[] {
  const pr: DashboardAction[] = [];
  if (cannotMerge(job, completion) === null) pr.push('merge');
  if (cannotRefreshPr(job) === null) pr.push('refresh-pr');
  // A finished job can only be hidden from (or brought back to) the board's default views, and
  // have its PR merged or re-read.
  if (TERMINAL_STATUSES.includes(job.status)) {
    return [...pr, job.archivedAt === null ? 'archive' : 'unarchive'];
  }
  const out: DashboardAction[] = [...pr];
  if (job.stage === 'needs-human') out.push('approve');
  if (job.round > 0) out.push('request-review');
  out.push('request-rework');
  if (policyDrift) out.push('accept-policy');
  // The same rule the transition applies: never for a pending or failing CI result.
  if (cannotAcceptDelivery(job) === null) out.push('accept-delivery');
  out.push('cancel');
  return out;
}

export interface ActionResult {
  job: Omit<Job, 'ownerToken'>;
  message: string;
  /** Present unless the job is finished: the command a session runs to carry on. */
  resumeCommand?: string;
}

function target(action: DashboardAction, job: Job, to: Stage | undefined): Stage {
  if (action === 'request-review') {
    if (job.round === 0)
      throw new ValidationError('Nothing has been built yet; request rework instead.');
    return 'review';
  }
  if (action === 'request-rework') return 'build';
  // approve
  const stage = to ?? job.returnStage ?? undefined;
  if (!stage || stage === 'needs-human' || stage === 'completed') {
    throw new ValidationError('Approve needs a stage to return to (to: <stage>).');
  }
  return stage;
}

/**
 * A short ownership episode: claim the job as `session` for one minute, run `fn` with the token,
 * release. A live lease held by another session is respected unless the job is waiting in
 * needs-human (its session is idle, not working) or the caller forces the takeover.
 */
function withLease<T>(
  store: Store,
  before: Job,
  session: string,
  force: boolean | undefined,
  fn: (token: string) => T,
): T {
  const waiting = before.stage === 'needs-human';
  const liveOwner =
    before.ownerSession !== null && before.ownerSession !== session && !leaseExpired(before, now());
  if (liveOwner && !waiting && !force) {
    throw new ValidationError(
      `Session ${String(before.ownerSession)} holds a live lease on this job` +
        (before.status === 'running' ? ' and reports it running' : '') +
        '. Use that session, wait for the lease to lapse, or confirm a forced takeover.',
    );
  }
  const { token } = claimJob(store, before.id, {
    session,
    force: force ?? (liveOwner && waiting),
    leaseMinutes: 1,
  });
  try {
    return fn(token);
  } finally {
    // Give the job up so a real session can resume it; a dashboard is not a worker.
    releaseJob(store, before.id, { token });
  }
}

export interface SupersedeInput {
  /** The replacement job. */
  by: string;
  session: string;
  force?: boolean | undefined;
}

/** `orch job supersede`: record that another job replaced this one, as a short episode. */
export function supersede(store: Store, id: string, input: SupersedeInput): Job {
  const before = getJob(store.db, id);
  withLease(store, before, input.session, input.force, (token) =>
    supersedeJob(store, id, { token }, input.by),
  );
  return getJob(store.db, id);
}

/** How the job completed, from its newest `job.completed` event. */
function completionFor(store: Store, job: Job): Completion {
  const completed = latestEventsByJob(store.db, [job.id], ['job.completed'])
    .get(job.id)
    ?.get('job.completed');
  return completionOf(job.stage, completed?.payload);
}

/** Read the PR from where the job's Git state lives (the worktree, else the initiating checkout). */
function ghCwd(job: Job): string {
  return job.worktreePath && existsSync(job.worktreePath) ? job.worktreePath : job.repoPath;
}

/**
 * Merge (a human's click, never a session) or re-read the PR. Merge re-reads GitHub first and
 * merges only the head the passing verdict was recorded for, as a merge commit; a merge GitHub
 * refuses is recorded and its message returned as the error. Nothing here changes stage or status.
 */
function prAction(store: Store, before: Job, input: ActionInput): ActionResult {
  const merge = input.action === 'merge';
  const refused = merge
    ? cannotMerge(before, completionFor(store, before))
    : cannotRefreshPr(before);
  if (refused)
    throw new ValidationError(`Cannot ${merge ? 'merge' : 'refresh the PR'}: ${refused}.`);
  const url = before.prUrl ?? '';
  const head = before.ciHead ?? '';
  const { error, message } = withLease(store, before, DASHBOARD_SESSION, input.force, (token) => {
    const pr = viewPr(url, ghCwd(before));
    const state = prWorkflowState(pr);
    if (!merge) {
      recordPrState(store, before.id, { token }, { event: 'pr.observed', state, head: pr.headSha });
      return { error: null, message: `GitHub reports ${url} as ${state ?? pr.state}.` };
    }
    const why =
      pr.state !== 'OPEN'
        ? `GitHub reports it ${pr.state}`
        : pr.isDraft
          ? 'it is still a draft'
          : pr.headSha !== head
            ? `its head is ${pr.headSha?.slice(0, 7) ?? '?'}, not the verified ${head.slice(0, 7)}`
            : pr.mergeable !== 'MERGEABLE'
              ? `GitHub reports it ${pr.mergeable ?? 'UNKNOWN'}, not MERGEABLE`
              : null;
    if (why) throw new ValidationError(`Cannot merge ${url}: ${why}. Refresh PR to update it.`);
    const failed = mergePr(url, head, ghCwd(before));
    recordPrState(store, before.id, { token }, { event: 'pr.merged', head, error: failed });
    return { error: failed, message: `Merged ${url} at ${head.slice(0, 7)}.` };
  });
  if (error !== null) throw new ValidationError(`gh pr merge failed: ${error}`);
  return { job: withoutToken(getJob(store.db, before.id)), message };
}

export function dashboardAction(store: Store, id: string, input: ActionInput): ActionResult {
  const before = getJob(store.db, id);
  if (input.action === 'merge' || input.action === 'refresh-pr') {
    return prAction(store, before, input);
  }
  if (input.action === 'archive' || input.action === 'unarchive') {
    const archive = input.action === 'archive';
    // Refuse before claiming so a refused request leaves the row untouched; setArchived
    // re-checks both rules inside its transaction.
    if (!TERMINAL_STATUSES.includes(before.status)) {
      throw new ValidationError(
        `Only a finished job can be archived; this one is ${before.status}.`,
      );
    }
    if (archive !== (before.archivedAt === null)) {
      throw new ValidationError(archive ? 'Job is already archived.' : 'Job is not archived.');
    }
    const note = input.reason?.trim();
    withLease(store, before, DASHBOARD_SESSION, input.force, (token) =>
      setArchived(store, id, { token }, archive, note === '' ? undefined : note),
    );
    return {
      job: withoutToken(getJob(store.db, id)),
      message: archive
        ? 'Job archived: hidden from the board unless Show is set to archived.'
        : 'Job unarchived: it is back in the board views.',
    };
  }
  if (TERMINAL_STATUSES.includes(before.status)) {
    throw new ValidationError(`Job is already ${before.status}.`);
  }
  if (input.action === 'approve' && before.stage !== 'needs-human') {
    throw new ValidationError('Only a job waiting in needs-human can be approved from here.');
  }
  if (input.action === 'accept-delivery') {
    const refused = cannotAcceptDelivery(before);
    if (refused) throw new ValidationError(`Cannot accept delivery: ${refused}.`);
    // A manual close-out is recorded with why the human made it; there is no default reason.
    if (!input.reason?.trim()) {
      throw new ValidationError('Accepting delivery needs a reason; it is recorded with the job.');
    }
  }
  const text = input.reason?.trim();
  const reason = `dashboard: ${text !== undefined && text !== '' ? text : input.action}`;
  withLease(store, before, DASHBOARD_SESSION, input.force, (token) => {
    const current = getJob(store.db, id);
    if (input.action === 'cancel') {
      transitionJob(store, id, 'cancel', { token, reason });
    } else if (input.action === 'accept-delivery') {
      // The pure transition re-checks the rule; this is the only path that completes a job by hand.
      transitionJob(store, id, 'resume', { token, to: 'completed', reason });
    } else if (input.action === 'accept-policy') {
      // A human adopts the worktree's factory.json at HEAD as this job's verification policy.
      const tree = worktreeOf(current);
      if (!tree) throw new ValidationError('The job has no worktree to read factory.json from.');
      const policy = candidatePolicy(tree);
      if (policy.commands.length === 0) {
        throw new ValidationError('factory.json at HEAD defines no verification commands.');
      }
      authorizePolicy(store, id, { token }, policy, tree.head, policyFingerprint(policy));
    } else {
      const to = target(input.action, current, input.to);
      if (current.stage !== 'needs-human') {
        transitionJob(store, id, 'escalate', { token, reason });
      }
      transitionJob(store, id, 'resume', { token, to, reason });
    }
  });
  const job = getJob(store.db, id);
  const safe = withoutToken(job);
  const resume = `orch factory resume ${id} --session <name>`;
  if (input.action === 'cancel') {
    return { job: safe, message: `Job cancelled (${reason}).` };
  }
  if (input.action === 'accept-delivery') {
    return {
      job: safe,
      message:
        `Delivery accepted by a human (${reason}): the job is completed without a passing CI verdict. ` +
        `CI was ${job.ciStatus ?? 'not observed'} for ${job.ciHead?.slice(0, 7) ?? '?'}; the PR is ` +
        `${job.prState ?? 'in an unknown state'}. Nothing was merged or marked ready.`,
    };
  }
  if (input.action === 'accept-policy') {
    return {
      job: safe,
      message:
        `Verification policy from factory.json at ${job.policyHead?.slice(0, 7) ?? '?'} accepted (${reason}). ` +
        'Earlier verification runs are stale; the next orch verify uses the accepted checks.',
      resumeCommand: resume,
    };
  }
  return {
    job: safe,
    message:
      `Recorded: job returned to ${job.stage} (pending). No session is running it; ` +
      `resume it from a Claude Code session with: ${resume}`,
    resumeCommand: resume,
  };
}
