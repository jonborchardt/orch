/**
 * Human actions on a job from the dashboard (or any non-session tool). Each one is a short
 * ownership episode as session `dashboard`: claim, apply validated workflow transitions, release.
 * Nothing here wakes a Claude session; the result always says the job must be resumed.
 */
import { ValidationError } from '../core/errors.ts';
import { leaseExpired } from '../core/ownership.ts';
import { cannotAcceptDelivery, now, type Stage, TERMINAL_STATUSES } from '../core/workflow.ts';
import type { Store } from '../storage/client.ts';
import { policyFingerprint } from '../core/verification.ts';
import { claimJob, getJob, releaseJob, transitionJob } from '../storage/jobs.ts';
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
    'status' | 'stage' | 'round' | 'returnStage' | 'prUrl' | 'ciHead' | 'ciStatus' | 'prState'
  >,
  policyDrift: boolean,
): DashboardAction[] {
  if (TERMINAL_STATUSES.includes(job.status)) return [];
  const out: DashboardAction[] = [];
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

export function dashboardAction(store: Store, id: string, input: ActionInput): ActionResult {
  const before = getJob(store.db, id);
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
  // A session that escalated to needs-human is waiting, not working: no takeover ceremony.
  const waiting = before.stage === 'needs-human';
  const liveOwner =
    before.ownerSession !== null &&
    before.ownerSession !== DASHBOARD_SESSION &&
    !leaseExpired(before, now());
  if (liveOwner && !waiting && !input.force) {
    throw new ValidationError(
      `Session ${String(before.ownerSession)} holds a live lease on this job` +
        (before.status === 'running' ? ' and reports it running' : '') +
        '. Use that session, wait for the lease to lapse, or confirm a forced takeover.',
    );
  }
  const { token } = claimJob(store, id, {
    session: DASHBOARD_SESSION,
    force: input.force ?? (liveOwner && waiting),
    leaseMinutes: 1,
  });
  const text = input.reason?.trim();
  const reason = `dashboard: ${text !== undefined && text !== '' ? text : input.action}`;
  let job: Job;
  try {
    const current = getJob(store.db, id);
    if (input.action === 'cancel') {
      job = transitionJob(store, id, 'cancel', { token, reason });
    } else if (input.action === 'accept-delivery') {
      // The pure transition re-checks the rule; this is the only path that completes a job by hand.
      job = transitionJob(store, id, 'resume', { token, to: 'completed', reason });
    } else if (input.action === 'accept-policy') {
      // A human adopts the worktree's factory.json at HEAD as this job's verification policy.
      const tree = worktreeOf(current);
      if (!tree) throw new ValidationError('The job has no worktree to read factory.json from.');
      const policy = candidatePolicy(tree);
      if (policy.commands.length === 0) {
        throw new ValidationError('factory.json at HEAD defines no verification commands.');
      }
      job = authorizePolicy(store, id, { token }, policy, tree.head, policyFingerprint(policy));
    } else {
      const to = target(input.action, current, input.to);
      if (current.stage !== 'needs-human') {
        transitionJob(store, id, 'escalate', { token, reason });
      }
      job = transitionJob(store, id, 'resume', { token, to, reason });
    }
  } finally {
    // Give the job up so a real session can resume it; a dashboard is not a worker.
    releaseJob(store, id, { token });
  }
  job = getJob(store.db, id);
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
