/**
 * What a job's status mail says (decision 2026-11-17-mail-reports-built-in-smtp-client). Pure:
 * the event types worth a mail, and the subject and plain-text body for one batch of them.
 */
import type { Event, Job } from '../storage/schema.ts';
import { STAGES, type Stage, type Status } from './workflow.ts';

/** The only emojis a status mail uses: single codepoints, no variation selectors. */
export const EMOJI = {
  success: '✅',
  failure: '❌',
  waiting: '✋',
  progress: '\u{1F504}',
  cancelled: '\u{1F6AB}',
  pending: '⬜',
} as const;

const STATUS_EMOJI: Record<Status, string> = {
  pending: EMOJI.progress,
  running: EMOJI.progress,
  blocked: EMOJI.waiting,
  interrupted: EMOJI.failure,
  completed: EMOJI.success,
  failed: EMOJI.failure,
  cancelled: EMOJI.cancelled,
};

/** Good news, bad news, or waiting: a job at `needs-human` waits on a person unless it stopped. */
export function outcomeEmoji(job: { stage: Stage; status: Status }): string {
  const own = STATUS_EMOJI[job.status];
  return job.stage === 'needs-human' && own === EMOJI.progress ? EMOJI.waiting : own;
}

const EVENT_EMOJI: Record<string, string> = {
  'stage.failed': EMOJI.failure,
  'recovery.failed': EMOJI.failure,
  'job.interrupted': EMOJI.failure,
  'job.blocked': EMOJI.waiting,
  'runner.stopped': EMOJI.waiting,
  'stage.completed': EMOJI.success,
  'job.completed': EMOJI.success,
  'job.cancelled': EMOJI.cancelled,
};

export function eventEmoji(type: string): string {
  return EVENT_EMOJI[type] ?? EMOJI.progress;
}

/** Every stage in workflow order: done, current (marked with the outcome emoji), or pending. */
export function stageLines(job: { stage: Stage; status: Status }): string[] {
  const at = job.status === 'completed' ? STAGES.length : STAGES.indexOf(job.stage);
  return STAGES.map((s, i) =>
    i < at
      ? `${EMOJI.success} ${s}  done`
      : i === at
        ? `${outcomeEmoji(job)} ${s}  current`
        : `${EMOJI.pending} ${s}  pending`,
  );
}

/**
 * State changes, errors, likely-flaky verification failures, and the factory controller giving a
 * ticket up (`runner.stopped`). Anything else (CI polls, pushes, verification runs, the
 * controller's Claude sessions) is not mailed.
 */
export const REPORTED_EVENTS: readonly string[] = [
  'job.created',
  'stage.started',
  'stage.completed',
  'stage.failed',
  'job.blocked',
  'job.resumed',
  'job.reworked',
  'job.cancelled',
  'job.completed',
  'job.interrupted',
  'recovery.failed',
  'verification.flaky',
  'runner.stopped',
];

/** The thread's subject without the configured prefix, which `sendReport` adds. */
export function reportSubject(job: Pick<Job, 'id' | 'title'>): string {
  return `${job.id}: ${job.title.replace(/[\r\n]+/g, ' ')}`;
}

function describe(e: Event): string {
  const str = (key: string): string | null => {
    const v = e.payload[key];
    return typeof v === 'string' && v !== '' ? v : null;
  };
  const stage = str('stage');
  const from = str('from');
  const to = str('to');
  const detail = [stage, from && `from ${from}`, to && `to ${to}`].filter(Boolean).join(', ');
  const why = str('reason');
  // A flake is a label, not a verdict: the same hedge as the dashboard and `orch factory status`.
  const hedge = e.type === 'verification.flaky' ? 'likely flaky test: ' : '';
  const reason = why ? `\n    reason: ${hedge}${why}` : '';
  return `${eventEmoji(e.type)} ${e.createdAt}  ${e.type}${detail ? ` (${detail})` : ''}${reason}`;
}

/** What a stopped job needs from the reader, derived by the caller (`ops/mail.ts`). */
export interface Needed {
  summary: string;
  /** The recorded reason, verbatim. */
  detail: string | null;
  /** The next command or dashboard action, one per line. */
  next: readonly string[];
  /** Needs-human: what is needed and one line per choice (with its link), before all else. */
  ask?: { needed: string; options: readonly string[] } | undefined;
}

function neededLines(n: Needed): string[] {
  return [
    ...(n.ask ? [n.ask.needed, 'Options:', ...n.ask.options] : []),
    n.summary,
    ...(n.detail ? [`Reason: ${n.detail}`] : []),
    ...n.next,
    '',
  ];
}

/**
 * Body of one status mail: an outcome headline, what the job needs (when it needs anything),
 * every stage, then each reported event in order.
 */
export function reportBody(
  job: Pick<Job, 'id' | 'title' | 'repo' | 'stage' | 'status' | 'prUrl'>,
  events: readonly Event[],
  needed: Needed | null = null,
): string {
  return [
    `${outcomeEmoji(job)} ${job.status} at ${job.stage}`,
    '',
    ...(needed ? neededLines(needed) : []),
    `Job:    ${job.id}`,
    `Title:  ${job.title}`,
    `Repo:   ${job.repo}`,
    ...(job.prUrl ? [`PR:     ${job.prUrl}`] : []),
    '',
    'Stages:',
    ...stageLines(job),
    '',
    'Events:',
    ...events.map(describe),
    '',
    `Inspect: orch factory status ${job.id}`,
    '',
  ].join('\n');
}
