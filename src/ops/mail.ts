/**
 * Job status mail (decision 2026-11-17-mail-reports-built-in-smtp-client). After an operation, every
 * job that gained reported events gets one mail summarising them, in the job's own thread. Sends
 * are at most once: the batch is claimed before sending and never retried. Mail never fails, blocks,
 * or rolls back the operation: `reportJobMail` never throws.
 */
import { type Needed, REPORTED_EVENTS, reportBody, reportSubject } from '../core/mail-report.ts';
import { DEFAULT_PORT } from '../core/paths.ts';
import { type MailConfig, mailConfig, sendReport } from '../integrations/mail.ts';
import { BLOCKER_EVENTS, blockerOf, ciView, liveness, resumeOf } from '../server/status.ts';
import { listArtifacts } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import {
  eventsAfter,
  jobsWithEventsAfter,
  latestEventsByJob,
  maxEventId,
} from '../storage/events.ts';
import { claimMailCursor, getJob, type MailOutcome, recordMailOutcome } from '../storage/jobs.ts';
import type { Event, Job } from '../storage/schema.ts';
import { latestRun } from '../storage/verification.ts';
import { allowedActions, choiceLine, choiceLinks, needsHuman } from './actions.ts';
import { planJob } from './factory.ts';
import type { RunSummary } from './run.ts';
import { formatSummary, runSubject } from './run-report.ts';

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

/**
 * What the job needs now, from the dashboard's own derivations (as `jobDetail` in server/api.ts
 * calls them), or null when it needs nothing (running, completed). A needs-human job leads with
 * `needsHuman`: what is needed, then each choice with its `?choose=` link.
 */
function neededOf(store: Store, job: Job): Needed | null {
  let plan = null;
  try {
    plan = planJob(store, job.id);
  } catch {
    /* no plan: no policy drift and no worktree head, as on the board */
  }
  const evidence = {
    events:
      latestEventsByJob(store.db, [job.id], BLOCKER_EVENTS).get(job.id) ?? new Map<string, Event>(),
    artifacts: listArtifacts(store.db, job.id),
    latestRun: latestRun(store.db, job.id)?.run ?? null,
  };
  const ci = ciView(job, evidence.events, plan?.worktree?.head ?? undefined);
  const state = liveness(job);
  const blocker = blockerOf(job, state, evidence);
  if (!blocker) return null;
  const next: string[] = [];
  let lead: string[] | undefined;
  if (state === 'blocked') {
    const actions = allowedActions(
      job,
      plan?.verification?.policy.authorization === 'required',
      ci.completion,
      null,
      true,
    );
    const view = needsHuman(store, job, actions);
    if (view) {
      const options = choiceLinks(job.id, view).map((c) => `  ${choiceLine(c)}`);
      lead = [view.needed, 'Options:', ...options];
    }
    next.push(
      `Dashboard: run orch ui, then open http://127.0.0.1:${String(DEFAULT_PORT)}/#/jobs/${job.id}`,
    );
  } else if (state !== 'cancelled') {
    const resume = resumeOf(job, state);
    if (resume?.command) next.push(`Resume: ${resume.command}`);
    else if (resume?.heldBy) {
      const until = resume.heldBy.leaseExpiresAt ? ` until ${resume.heldBy.leaseExpiresAt}` : '';
      next.push(`Resume: held by session ${resume.heldBy.session}${until}`);
    }
  }
  if (blocker.kind === 'ci') next.push(ci.guidance);
  return { summary: blocker.summary, detail: blocker.detail, next, lead };
}

/** The block is help, not a requirement: a failure to derive it never stops the mail. */
function safeNeededOf(store: Store, job: Job): Needed | null {
  try {
    return neededOf(store, job);
  } catch {
    return null;
  }
}

async function deliver(
  cfg: MailConfig | string,
  job: Job,
  batch: readonly Event[],
  needed: Needed | null,
): Promise<MailOutcome> {
  if (typeof cfg === 'string') return { sent: false, error: cfg };
  const subject = job.mailSubject ?? reportSubject(job);
  const thread = job.mailThreadId;
  const last = job.mailLastId ?? thread;
  try {
    const { messageId } = await sendReport(cfg, {
      subject,
      text: reportBody(job, batch, needed),
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
        const needed = typeof cfg === 'string' ? null : safeNeededOf(store, job);
        const outcome = await deliver(cfg, job, batch, needed);
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

/**
 * The end-of-session mail: the controller's report (`formatSummary`) sent once, unthreaded, when
 * mail is configured. Nothing is recorded and nothing retried; a configuration error or a failed
 * send is one `log` line. Never throws.
 */
export async function reportRunMail(
  store: Store,
  summary: RunSummary,
  log: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    const cfg = mailConfig(env, store.paths.config);
    if (cfg === null) return;
    await sendReport(cfg, { subject: runSubject(summary), text: formatSummary(summary) });
  } catch (err) {
    log(`session mail not sent: ${message(err)}`);
  }
}
