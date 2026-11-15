/**
 * Pure derivations for the dashboard: execution state, the reason a job is not progressing, and
 * whether a session may resume it. Inputs are persisted rows only; the reason text shown is the
 * recorded one, verbatim, never parsed or guessed.
 */
import { leaseExpired } from '../core/ownership.ts';
import { blockingCount, MAX_CI_REPAIRS_REASON, MAX_ROUNDS_REASON, now } from '../core/workflow.ts';
import type { Artifact, Event, Job, VerificationRun } from '../storage/schema.ts';
import type { Blocker, CiView, Liveness, Resume } from './types.ts';

type Lease = Pick<Job, 'status' | 'stage' | 'leaseExpiresAt' | 'ownerSession'>;

export function liveness(job: Lease): Liveness {
  if (job.status === 'cancelled') return 'cancelled';
  if (job.status === 'completed') return 'completed';
  if (job.stage === 'needs-human' || job.status === 'blocked') return 'blocked';
  if (job.status === 'failed') return 'failed';
  if (job.status === 'interrupted') return 'interrupted';
  if (job.status === 'running') return leaseExpired(job, now()) ? 'stale' : 'running';
  return 'idle';
}

/** Event types whose newest occurrence explains a stopped job or its CI state. */
export const BLOCKER_EVENTS = [
  'job.blocked',
  'stage.failed',
  'job.interrupted',
  'job.cancelled',
  'ci.observed',
  'job.completed',
] as const;

export interface Evidence {
  /** Newest event per type, for the types in BLOCKER_EVENTS. */
  events: Map<string, Event>;
  artifacts: Artifact[];
  latestRun: VerificationRun | null;
}

function text(e: Event | undefined, key: string): string | null {
  const v = e?.payload[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function verificationFailed(run: VerificationRun | null, detail: string | null): Blocker | null {
  if (run?.status !== 'failed') return null;
  return {
    kind: 'verification',
    summary: `Verification failed at ${run.head.slice(0, 7)}`,
    detail,
  };
}

/** What the newest `orch gh ci` reconciliation concluded, when the newest observation is one. */
function lastOutcome(e: Event | undefined): string | null {
  return text(e, 'outcome');
}

/** One line for a ci-stage escalation, from the recorded reason code and the last CI outcome. */
function ciBlocker(
  job: Pick<Job, 'ciRepairs' | 'maxCiRepairs'>,
  blocked: Event | undefined,
  observed: Event | undefined,
): Blocker {
  const reason = text(blocked, 'reason');
  if (reason === MAX_CI_REPAIRS_REASON) {
    return {
      kind: 'ci',
      summary: `CI still failing after ${String(job.ciRepairs)} of ${String(job.maxCiRepairs)} repair cycles`,
      detail: text(blocked, 'detail'),
    };
  }
  const summaries: Record<string, string> = {
    closed: 'PR was closed without merging',
    outdated: 'PR head moved outside the job',
    none: 'GitHub reports no checks for the PR head',
    infrastructure: 'Required checks did not reach a verdict',
  };
  const outcome = lastOutcome(observed);
  return {
    kind: 'ci',
    summary: (outcome !== null ? summaries[outcome] : undefined) ?? 'Escalated from ci',
    detail: reason,
  };
}

export function blockerOf(
  job: Lease & Pick<Job, 'round' | 'ciRepairs' | 'maxCiRepairs'>,
  state: Liveness,
  ev: Evidence,
): Blocker | null {
  switch (state) {
    case 'running':
    case 'completed':
      return null;
    case 'cancelled': {
      const e = ev.events.get('job.cancelled');
      return {
        kind: 'cancelled',
        summary: `Cancelled during ${job.stage}${e?.actor ? ` by ${e.actor}` : ''}`,
        detail: text(e, 'reason'),
      };
    }
    case 'stale':
      return {
        kind: 'interrupted',
        summary: `Session ${job.ownerSession ?? '?'} stopped renewing its lease; presumed gone`,
        detail: null,
      };
    case 'interrupted': {
      const prev = text(ev.events.get('job.interrupted'), 'previousSession');
      return {
        kind: 'interrupted',
        summary: `Interrupted while running${prev ? ` under session ${prev}` : ''}`,
        detail: null,
      };
    }
    case 'failed': {
      const reason = text(ev.events.get('stage.failed'), 'reason');
      return (
        verificationFailed(ev.latestRun, reason) ?? {
          kind: 'failed',
          summary: `Stage ${job.stage} failed`,
          detail: reason,
        }
      );
    }
    case 'blocked': {
      const e = ev.events.get('job.blocked');
      const from = text(e, 'from');
      const reason = text(e, 'reason');
      if (from === 'review' && reason === MAX_ROUNDS_REASON) {
        const n = blockingCount(ev.artifacts, job.round);
        return {
          kind: 'findings',
          summary:
            n > 0
              ? `${String(n)} blocking finding(s) remain after the last allowed review round`
              : 'Reviewers still request changes after the last allowed review round',
          detail: null,
        };
      }
      if (from === 'ci') return ciBlocker(job, e, ev.events.get('ci.observed'));
      const decision = ev.artifacts.find((a) => a.path === 'decision.md')?.marker;
      if (from === 'approve' && decision === 'escalate') {
        return {
          kind: 'decision',
          summary: 'Approver escalated: a human must decide',
          detail: reason,
        };
      }
      return (
        verificationFailed(ev.latestRun, reason) ?? {
          kind: 'escalated',
          summary: from ? `Escalated from ${from}` : 'Escalated',
          detail: reason,
        }
      );
    }
    case 'idle': {
      if (job.ownerSession === null) {
        return { kind: 'waiting', summary: 'No session owns this job', detail: null };
      }
      if (leaseExpired(job, now())) {
        return {
          kind: 'waiting',
          summary: `Lease held by ${job.ownerSession} lapsed; presumed gone`,
          detail: null,
        };
      }
      return null;
    }
  }
}

type CiRow = Pick<
  Job,
  | 'id'
  | 'stage'
  | 'prUrl'
  | 'prState'
  | 'ciHead'
  | 'ciStatus'
  | 'ciCheckedAt'
  | 'ciRepairs'
  | 'maxCiRepairs'
> &
  Partial<Pick<Job, 'ownerSession'>>;

const sha7 = (sha: string | null): string => (sha ? sha.slice(0, 7) : '?');

/**
 * What the CI state means for the person reading it, from the server's structured fields only:
 * the rollup and the commit it was read for, whether that commit is still HEAD, the newest
 * reconciliation outcome, the repair budget, and how a finished job finished. The client renders
 * these two strings; the controls it offers come from the action list, never from this text.
 */
export function ciSummary(
  ci: Omit<CiView, 'line' | 'guidance'>,
  job: Pick<Job, 'id' | 'stage' | 'prUrl' | 'prState'> & Partial<Pick<Job, 'ownerSession'>>,
): { line: string; guidance: string } {
  const at = `for ${sha7(ci.head)}`;
  const budget = `${String(ci.repairs)} of ${String(ci.maxRepairs)} repairs used`;
  if (ci.completion === 'human') {
    return {
      line: `Completed by human close-out; CI was ${ci.status ?? 'not observed'} ${at}.`,
      guidance:
        'A human accepted the delivery without a passing CI verdict (the reason is in the events). ' +
        'This is not an automated verification result.',
    };
  }
  if (ci.completion === 'legacy') {
    return {
      line: 'Completed before the ci stage existed; no CI verdict was recorded for a commit.',
      guidance: 'Check the PR on GitHub directly; nothing here vouches for its checks.',
    };
  }
  if (ci.completion === 'ci') {
    return {
      line: `Completed: required checks passed ${at}.`,
      guidance: 'orch marks the draft PR ready; humans merge, the factory never does.',
    };
  }
  if (!job.prUrl) return { line: 'No PR yet.', guidance: 'CI is observed once a draft PR exists.' };
  if (ci.head === null || ci.status === null) {
    return {
      line: 'PR created; CI not yet observed.',
      guidance: `A session runs orch gh ci ${job.id} to read the checks for the PR head.`,
    };
  }
  const stale =
    ci.current === false ? ` That is not the current HEAD, so it no longer counts.` : '';
  if (job.prState === 'merged') {
    return {
      line: `PR merged outside the factory; CI was ${ci.status} ${at}.`,
      guidance: 'If the job is escalated from ci, a human may accept the delivery to close it out.',
    };
  }
  if (ci.outcome === 'closed') {
    return {
      line: `PR closed without merging; CI was ${ci.status} ${at}.`,
      guidance: 'Reopen the PR and Approve back to ci, or cancel the job.',
    };
  }
  if (ci.outcome === 'outdated') {
    return {
      line: `PR head moved outside the job; last verdict ${ci.status} ${at}.`,
      guidance: 'Approve back to pr to re-push the approved HEAD, or back to ci to re-read checks.',
    };
  }
  if (ci.status === 'none') {
    return {
      line: `GitHub reports no checks ${at}.`,
      guidance:
        'Add CI and Approve back to ci, or accept the delivery by hand (recorded as a human close-out).',
    };
  }
  if (ci.outcome === 'infrastructure') {
    return {
      line: `Required checks did not reach a verdict ${at}.${stale}`,
      guidance: 'Not a code defect: re-run the workflow or fix CI, then Approve back to ci.',
    };
  }
  if (ci.status === 'failing') {
    const exhausted = job.stage === 'needs-human' && ci.repairs >= ci.maxRepairs;
    if (exhausted) {
      return {
        line: `CI still failing ${at}; ${budget}.`,
        guidance:
          'The repair budget is spent. Request rework for one more attempt, fix it by hand on the ' +
          'branch and Approve back to ci, or cancel. Completion is not available while checks fail.',
      };
    }
    if (job.stage !== 'ci') {
      return {
        line: `CI failed ${at}; repair in progress (${budget}, stage ${job.stage}).`,
        guidance:
          'The builder repairs from the saved logs; the fix is reviewed and approved again.',
      };
    }
    return {
      line: `CI failing ${at}; ${budget}.${stale}`,
      guidance: 'orch gh ci acts on it next.',
    };
  }
  if (ci.status === 'pending') {
    return {
      line: `CI pending ${at}.${stale}`,
      guidance:
        job.ownerSession === null
          ? `No session is polling: the job was released while CI ran. Resume it (/factory ${job.id}) to read CI again. Completion is not available.`
          : 'Waiting on GitHub; the session polls with orch gh ci. Completion is not available.',
    };
  }
  // passing
  return {
    line: `CI passing ${at}.${stale}`,
    guidance:
      ci.current === false
        ? `Run orch gh ci ${job.id} again for the current HEAD.`
        : 'The session completes the job; nothing here merges or marks the PR ready.',
  };
}

/**
 * The CI state to show, from the job row and the newest `ci.observed` / `job.completed` events.
 * `head` is the worktree HEAD when the caller inspected it (null or undefined when it could not);
 * the rollup is "current" only when it describes that commit, so an old green verdict is never
 * shown as current after the head moved.
 */
export function ciView(
  job: CiRow,
  events: Map<string, Event>,
  head: string | null | undefined,
): CiView {
  const observed = events.get('ci.observed');
  // A reconciliation outcome counts only when the observation describes the recorded head.
  const forHead = observed && text(observed, 'head') === job.ciHead ? observed : undefined;
  const failures = Array.isArray(forHead?.payload['failures'])
    ? (forHead.payload['failures'] as CiView['failures'])
    : [];
  const completed = events.get('job.completed');
  let completion: CiView['completion'] = null;
  if (job.stage === 'completed') {
    completion =
      completed?.payload['acceptedByHuman'] === true
        ? 'human'
        : typeof completed?.payload['head'] === 'string'
          ? 'ci'
          : 'legacy';
  }
  const view = {
    head: job.ciHead,
    current: head == null ? null : job.ciHead !== null && job.ciHead === head,
    status: job.ciStatus,
    checkedAt: job.ciCheckedAt,
    repairs: job.ciRepairs,
    maxRepairs: job.maxCiRepairs,
    outcome: lastOutcome(forHead),
    reason: text(forHead, 'reason'),
    failures,
    completion,
  };
  return { ...view, ...ciSummary(view, job) };
}

/**
 * Whether a Claude Code session may resume the job now. Null for finished jobs (the workflow
 * refuses). A live lease, whoever holds it, means `orch factory resume` would be refused without
 * a deliberate `--force` from that session's owner, so the command is withheld and the holder is
 * named instead; a lapsed lease is the normal resume case. Nothing here changes ownership.
 */
export function resumeOf(job: Lease & Pick<Job, 'id'>, state: Liveness): Resume | null {
  if (state === 'completed' || state === 'cancelled') return null;
  if (job.ownerSession !== null && !leaseExpired(job, now())) {
    return {
      command: null,
      heldBy: { session: job.ownerSession, leaseExpiresAt: job.leaseExpiresAt },
    };
  }
  return { command: `/factory resume ${job.id}`, heldBy: null };
}
