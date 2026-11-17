/**
 * Job status mail (decision 2026-11-17-mail-reports-built-in-smtp-client). After an operation, every
 * job that gained reported events gets one mail summarising them, in the job's own thread. Sends
 * are at most once: the batch is claimed before sending and never retried. Mail never fails, blocks,
 * or rolls back the operation: `reportJobMail` never throws.
 */
import { REPORTED_EVENTS, reportBody, reportSubject } from '../core/mail-report.ts';
import { type MailConfig, mailConfig, sendReport } from '../integrations/mail.ts';
import type { Store } from '../storage/client.ts';
import { eventsAfter, jobsWithEventsAfter, maxEventId } from '../storage/events.ts';
import { claimMailCursor, getJob, type MailOutcome, recordMailOutcome } from '../storage/jobs.ts';
import type { Event, Job } from '../storage/schema.ts';

export interface JobMailOutcome {
  jobId: string;
  messageId: string | null;
  /** Why the mail was not sent; never contains credentials. */
  error: string | null;
}

/** Take before an operation; pass to `reportJobMail` after it. */
export function mailWatermark(store: Store): number {
  return maxEventId(store.db);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function deliver(
  cfg: MailConfig | string,
  job: Job,
  batch: readonly Event[],
): Promise<MailOutcome> {
  if (typeof cfg === 'string') return { sent: false, error: cfg };
  const subject = job.mailSubject ?? reportSubject(job);
  const thread = job.mailThreadId;
  const last = job.mailLastId ?? thread;
  try {
    const { messageId } = await sendReport(cfg, {
      subject,
      text: reportBody(job, batch),
      inReplyTo: last ?? undefined,
      references: thread && last ? [...new Set([thread, last])] : undefined,
    });
    return { sent: true, messageId, subject, inReplyTo: last };
  } catch (err) {
    return { sent: false, error: message(err) };
  }
}

/**
 * Mail each job with reported events after `sinceEventId` (and after its own cursor): claim,
 * compose, send as a reply in the job's thread, record `mail.sent` or `mail.failed`. Returns at
 * once, touching nothing, when mail is not configured. A configuration error is a failed outcome.
 */
export async function reportJobMail(
  store: Store,
  sinceEventId: number,
  env: Record<string, string | undefined> = process.env,
): Promise<JobMailOutcome[]> {
  let cfg: MailConfig | string;
  try {
    const c = mailConfig(env, store.paths.config);
    if (c === null) return [];
    cfg = c;
  } catch (err) {
    cfg = message(err);
  }
  const out: JobMailOutcome[] = [];
  try {
    for (const id of jobsWithEventsAfter(store.db, sinceEventId, REPORTED_EVENTS)) {
      try {
        const job = getJob(store.db, id);
        const since = Math.max(job.mailCursor ?? 0, sinceEventId);
        const batch = eventsAfter(store.db, id, since, REPORTED_EVENTS);
        const last = batch.at(-1);
        if (!last || !claimMailCursor(store, id, job.mailCursor, last.id)) continue;
        const outcome = await deliver(cfg, job, batch);
        recordMailOutcome(store, id, outcome);
        out.push(
          outcome.sent
            ? { jobId: id, messageId: outcome.messageId, error: null }
            : { jobId: id, messageId: null, error: outcome.error },
        );
      } catch (err) {
        out.push({ jobId: id, messageId: null, error: message(err) });
      }
    }
  } catch (err) {
    out.push({ jobId: '(all)', messageId: null, error: message(err) });
  }
  return out;
}
