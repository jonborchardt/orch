/**
 * What a job's status mail says (decision 2026-11-17-mail-reports-built-in-smtp-client). Pure:
 * the event types worth a mail, and the subject and plain-text body for one batch of them.
 */
import type { Event, Job } from '../storage/schema.ts';

/** State changes and errors. Anything else (CI polls, pushes, verification runs) is not mailed. */
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
  const reason = why ? `\n    reason: ${why}` : '';
  return `- ${e.createdAt}  ${e.type}${detail ? ` (${detail})` : ''}${reason}`;
}

/** Body of one status mail: where the job is now, then each reported event in order. */
export function reportBody(
  job: Pick<Job, 'id' | 'title' | 'repo' | 'stage' | 'status' | 'prUrl'>,
  events: readonly Event[],
): string {
  return [
    `Job:    ${job.id}`,
    `Title:  ${job.title}`,
    `Repo:   ${job.repo}`,
    `Stage:  ${job.stage}`,
    `Status: ${job.status}`,
    ...(job.prUrl ? [`PR:     ${job.prUrl}`] : []),
    '',
    'Events:',
    ...events.map(describe),
    '',
    `Inspect: orch factory status ${job.id}`,
    '',
  ].join('\n');
}
