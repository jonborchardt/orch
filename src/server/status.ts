/**
 * Pure derivations for the dashboard: execution state, the reason a job is not progressing, and
 * whether a session may resume it. Inputs are persisted rows only; the reason text shown is the
 * recorded one, verbatim, never parsed or guessed.
 */
import { leaseExpired } from '../core/ownership.ts';
import {
  blockingCount,
  completionOf,
  MAX_CI_REPAIRS_REASON,
  MAX_ROUNDS_REASON,
  now,
  prPhase,
  type PrPhase,
  SCOPE_GAP_REASON,
  specChallengeState,
} from '../core/workflow.ts';
import type { Artifact, Event, Job, VerificationRun } from '../storage/schema.ts';
import type {
  Blocker,
  CiView,
  Liveness,
  Outcome,
  OutcomeKind,
  Progress,
  Resume,
  StepId,
  StepState,
  Timeline,
  TimelineEntry,
} from './types.ts';

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
  'runner.stopped',
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
    merged: 'PR merged by a human, but delivery was refused',
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

/**
 * The factory controller's newest `runner.stopped`, while it is still the job's last news: the job
 * is at the stage and status the stop recorded and no other loaded event is newer. Display only.
 */
function stoppedBlocker(job: Lease, ev: Evidence): Blocker | null {
  const stop = ev.events.get('runner.stopped');
  if (stop === undefined) return null;
  if (stop.payload['stage'] !== job.stage || stop.payload['status'] !== job.status) return null;
  for (const e of ev.events.values()) if (e.id > stop.id) return null;
  return {
    kind: 'stopped',
    summary: `Factory controller stopped it: ${text(stop, 'code') ?? '?'}`,
    detail: text(stop, 'reason'),
    next: text(stop, 'next'),
  };
}

export function blockerOf(
  job: Lease & Pick<Job, 'round' | 'ciRepairs' | 'maxCiRepairs'> & Partial<Pick<Job, 'prState'>>,
  state: Liveness,
  ev: Evidence,
): Blocker | null {
  switch (state) {
    case 'running':
      return null;
    case 'completed':
      return job.prState === 'merged' ? null : stoppedBlocker(job, ev);
    case 'cancelled': {
      const e = ev.events.get('job.cancelled');
      return {
        kind: 'cancelled',
        summary: `Cancelled during ${job.stage}${e?.actor ? ` by ${e.actor}` : ''}`,
        detail: text(e, 'reason'),
      };
    }
    case 'stale':
      return (
        stoppedBlocker(job, ev) ?? {
          kind: 'interrupted',
          summary: `Session ${job.ownerSession ?? '?'} stopped renewing its lease; presumed gone`,
          detail: null,
        }
      );
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
      // Before verificationFailed on purpose: the gap is why the job stopped, not a stale run.
      if (from === 'approve' && reason === SCOPE_GAP_REASON) {
        const gap = text(e, 'detail');
        return {
          kind: 'escalated',
          summary: gap
            ? `Repeated scope gap at approval: ${gap}`
            : 'Repeated scope gap at approval',
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
        return (
          stoppedBlocker(job, ev) ?? {
            kind: 'waiting',
            summary: 'No session owns this job',
            detail: null,
          }
        );
      }
      if (leaseExpired(job, now())) {
        return (
          stoppedBlocker(job, ev) ?? {
            kind: 'waiting',
            summary: `Lease held by ${job.ownerSession} lapsed; presumed gone`,
            detail: null,
          }
        );
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
  if (ci.completion === 'merged') {
    return {
      line: `PR merged by a human before CI finished; CI was ${ci.status ?? 'not observed'} ${at}.`,
      guidance:
        'Completed: a human merged the PR at the verified, approved HEAD before the checks reached ' +
        'a verdict. Check the base branch on GitHub if the checks matter.',
    };
  }
  if (ci.completion === 'legacy') {
    return {
      line: 'Completed before the ci stage existed; no CI verdict was recorded for a commit.',
      guidance: 'Check the PR on GitHub directly; nothing here vouches for its checks.',
    };
  }
  if (ci.completion === 'ci') {
    const guidance: Partial<Record<PrPhase, string>> = {
      'ready-to-merge':
        'Ready to merge: Merge here or on GitHub, or orch job merge where the repository is opted in; the factory never does.',
      merged: 'Merged.',
      closed: 'The PR was closed without merging.',
      'ready-mark-failed': `Ready marking failed: run gh pr ready ${job.prUrl ?? ''}, then Refresh PR.`,
    };
    const phase = prPhase({ prUrl: job.prUrl, prState: job.prState, ciStatus: ci.status }, 'ci');
    return {
      line: `Completed: required checks passed ${at}.`,
      guidance: guidance[phase] ?? 'Refresh the PR to read its state from GitHub.',
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
      guidance: 'Reopen the PR and Resume at CI, or cancel the job.',
    };
  }
  if (ci.outcome === 'outdated') {
    return {
      line: `PR head moved outside the job; last verdict ${ci.status} ${at}.`,
      guidance: 'Resume at PR to re-push the approved HEAD, or at CI to re-read checks.',
    };
  }
  if (ci.status === 'none') {
    return {
      line: `GitHub reports no checks ${at}.`,
      guidance:
        'Add CI and Resume at CI, or accept the delivery by hand (recorded as a human close-out).',
    };
  }
  if (ci.outcome === 'infrastructure') {
    return {
      line: `Required checks did not reach a verdict ${at}.${stale}`,
      guidance: 'Not a code defect: re-run the workflow or fix CI, then Resume at CI.',
    };
  }
  if (ci.status === 'failing') {
    const exhausted = job.stage === 'needs-human' && ci.repairs >= ci.maxRepairs;
    if (exhausted) {
      return {
        line: `CI still failing ${at}; ${budget}.`,
        guidance:
          'The repair budget is spent. Request rework for one more attempt, fix it by hand on the ' +
          'branch and Resume at CI, or cancel. Completion is not available while checks fail.',
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
        : 'The session completes the job with orch gh ci, which marks the draft PR ready; nothing here merges.',
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
  const completion = completionOf(job.stage, events.get('job.completed')?.payload);
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

const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  merged: 'completed: merged',
  ready: 'completed: PR ready, checks passed',
  human: 'completed: human close-out',
  completed: 'completed',
};

/**
 * How a completed job ended, null for any other job. A recorded merge wins over how the workflow
 * completed; a ready PR counts only while the recorded CI still passes; anything the record cannot
 * vouch for (legacy, draft or closed PR, CI later failing) is plain `completed`, never a guess.
 */
export function outcomeOf(
  state: Liveness,
  job: Pick<Job, 'prUrl' | 'prState' | 'ciStatus'>,
  completion: CiView['completion'],
): Outcome | null {
  if (state !== 'completed') return null;
  const kind: OutcomeKind =
    job.prState === 'merged'
      ? 'merged'
      : completion === 'ci' && prPhase(job, completion) === 'ready-to-merge'
        ? 'ready'
        : completion === 'human'
          ? 'human'
          : 'completed';
  return { kind, label: OUTCOME_LABEL[kind] };
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

const STEPS: { id: StepId; label: string }[] = [
  { id: 'spec', label: 'Spec' },
  { id: 'build', label: 'Build' },
  { id: 'simplify', label: 'Simplify' },
  { id: 'review', label: 'Review' },
  { id: 'approve', label: 'Approve' },
  { id: 'pr', label: 'PR' },
  { id: 'ci', label: 'CI' },
  { id: 'done', label: 'Done' },
];

const FAST_STEPS: readonly StepId[] = ['build', 'pr', 'ci', 'done'];

/** Step index of a delivery stage; -1 for anything else (needs-human, completed, null). */
function stepIndex(stage: unknown, list: readonly { id: StepId }[] = STEPS): number {
  return stage === 'done' ? -1 : list.findIndex((s) => s.id === stage);
}

const STOPPED: Partial<Record<Job['status'], string>> = {
  interrupted: 'interrupted',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * Where the job is, from its row and the newest `job.blocked` event (in the BLOCKER_EVENTS map the
 * board already loads). An escalated job is stopped at the stage it escalated from, which for an
 * exhausted CI repair budget is `ci` even though `returnStage` says build. The spec challenge
 * comes from the artifact rows the caller already loaded.
 */
export function progressOf(
  job: Pick<Job, 'stage' | 'status' | 'returnStage'> & Partial<Pick<Job, 'mode'>>,
  events: Map<string, Event>,
  artifacts: readonly Artifact[],
): Progress {
  return { ...position(job, events), specChallenge: specChallengeState(artifacts, job) };
}

function position(
  job: Pick<Job, 'stage' | 'status' | 'returnStage'> & Partial<Pick<Job, 'mode'>>,
  events: Map<string, Event>,
): Omit<Progress, 'specChallenge'> {
  // A fast job never visits spec, simplify, review, or approve, so they are not its steps.
  const list = job.mode === 'fast' ? STEPS.filter((s) => FAST_STEPS.includes(s.id)) : STEPS;
  const index = (stage: unknown) => stepIndex(stage, list);
  const steps = (position: number, at: StepState): Progress['steps'] =>
    list.map((s, i) => ({
      ...s,
      state: i < position ? 'done' : i === position ? at : 'not-started',
    }));
  if (job.status === 'completed' || job.stage === 'completed') {
    return { steps: steps(list.length, 'done'), position: list.length, label: 'Done' };
  }
  let position = index(job.stage);
  if (job.stage === 'needs-human') {
    position = index(text(events.get('job.blocked'), 'from'));
    if (position < 0) position = index(job.returnStage);
  }
  const reason = job.stage === 'needs-human' ? 'needs human' : STOPPED[job.status];
  if (position < 0) {
    const label = reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}` : 'Unknown';
    return { steps: steps(-1, 'current'), position: -1, label };
  }
  const name = list[position]?.label ?? '';
  return {
    steps: steps(position, reason ? 'stopped' : 'current'),
    position,
    label: reason ? `${name}, ${reason}` : name,
  };
}

/** The detail view loads at most this many newest events; the timeline says when it hit the cap. */
export const TIMELINE_EVENTS = 500;

const stepName = (stage: unknown): string =>
  STEPS.find((s) => s.id === stage)?.label ?? (typeof stage === 'string' ? stage : '?');
const asStep = (stage: unknown): StepId | null => STEPS[stepIndex(stage)]?.id ?? null;

/**
 * Stage entries and exits in event order (oldest first). A step entered again after going back
 * (changes requested, rework, resume to an earlier stage) is a new entry, never an edit.
 */
export function timelineOf(events: readonly Event[]): Timeline {
  const entries: TimelineEntry[] = [];
  // The step the job was last seen in, for events that do not name one (job.interrupted).
  let at: StepId | null = null;
  const add = (e: Event, step: StepId | null, kind: TimelineEntry['kind'], label: string) => {
    entries.push({ at: e.createdAt, step, kind, label });
  };
  for (const [i, e] of events.entries()) {
    const p = e.payload;
    switch (e.type) {
      case 'stage.started':
        at = asStep(p['stage']);
        add(e, at, 'started', `${stepName(p['stage'])} started`);
        break;
      case 'stage.completed': {
        const step = asStep(p['stage']);
        const changes = p['changesRequestedBy'];
        const back =
          step === 'review' &&
          ((Array.isArray(changes) && changes.length > 0) || Number(p['blocking'] ?? 0) > 0);
        const n = p['round'];
        const round = `Review round ${typeof n === 'number' ? String(n) : '?'}`;
        // The last allowed round escalates in the same transition instead of returning to Build.
        const escalated = back && events[i + 1]?.type === 'job.blocked';
        const label =
          step !== 'review'
            ? `${stepName(p['stage'])} completed`
            : escalated
              ? `${round}: changes requested`
              : back
                ? `${round}: changes requested, back to Build`
                : `${round} passed`;
        add(e, step, back && !escalated ? 'back' : 'completed', label);
        break;
      }
      case 'stage.failed':
        add(e, asStep(p['stage']), 'stopped', `${stepName(p['stage'])} failed`);
        break;
      case 'job.blocked':
        at = asStep(p['from']) ?? at;
        add(e, asStep(p['from']), 'stopped', `${stepName(p['from'])}: needs human`);
        break;
      case 'job.resumed': {
        const to = p['to'] ?? p['stage'];
        if (to === 'completed') add(e, 'done', 'resumed', 'Delivery accepted by a human');
        else add(e, asStep(to), 'resumed', `Resumed at ${stepName(to)}`);
        break;
      }
      case 'job.reworked':
        add(e, asStep(p['from']), 'back', `Rework from ${stepName(p['from'])}: back to Build`);
        break;
      case 'job.interrupted':
        add(e, at, 'stopped', at ? `${stepName(at)} interrupted` : 'Interrupted');
        break;
      case 'job.cancelled': {
        // A job cancelled while escalated records stage needs-human, which is not a step.
        const step = asStep(p['stage']);
        add(e, step ?? at, 'stopped', step ? `Cancelled during ${stepName(step)}` : 'Cancelled');
        break;
      }
      case 'job.completed':
        add(e, 'done', 'completed', 'Done');
        break;
    }
  }
  return { entries, truncated: events.length >= TIMELINE_EVENTS };
}
