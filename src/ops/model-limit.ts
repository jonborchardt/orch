/**
 * A model's own allowance running out, as recorded on jobs (decision
 * 2026-11-26-per-model-limit-falls-back): `models.limit` says a model hit its limit, and
 * `models.fallback` says which role runs which other model from then on. The rules are pure, in
 * `core/roles.ts`; this module only reads and records.
 */
import { claudeLimit, limitUntil } from '../core/claude-limit.ts';
import { ValidationError } from '../core/errors.ts';
import { stripControl } from '../core/flake.ts';
import {
  drawnModelsOf,
  exhaustedModels,
  fallbacksOf,
  type Model,
  planFallbacks,
  resolveRoles,
} from '../core/roles.ts';
import { now } from '../core/workflow.ts';
import type { Store } from '../storage/client.ts';
import { eventsOfType, eventsOfTypes } from '../storage/events.ts';
import { type Auth, authorize, getJob, recordEvent } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { loadConfig } from './factory.ts';

/** A `models.limit` payload: `until` is an ISO time only when the text carried an epoch. */
export interface LimitRecord {
  model: Model;
  text: string;
  until: string | null;
}

const MAX_TEXT = 500;

/** The record for a limit message: its reset time is read from the text, never guessed. */
export function limitRecord(model: Model, text: string): LimitRecord {
  const t = stripControl(text).trim().slice(0, MAX_TEXT);
  return { model, text: t, until: limitUntil(claudeLimit(t, null)?.resetsAt) };
}

/**
 * `orch job limit`: the job's owner (its /factory session) reports that a subagent hit a model's
 * limit. Owner-checked in the write's transaction; the controller reads the row when the session
 * ends.
 */
export function reportLimit(
  store: Store,
  id: string,
  auth: Auth,
  input: { model: Model; text: string },
): Job {
  authorize(store, id, auth);
  if (input.text.trim() === '') throw new ValidationError('The limit text must not be blank.');
  return recordEvent(store, id, auth, 'models.limit', { ...limitRecord(input.model, input.text) });
}

/**
 * The fallbacks job `id` needs now, each with the limit that caused it: empty when no role of the
 * job runs an exhausted model, null when one does and has no other model in its pool. `session`
 * are the limits with no known reset that the calling controller remembers. Read-only.
 */
export function neededFallbacks(
  store: Store,
  id: string,
  session: readonly LimitRecord[],
): Record<string, unknown>[] | null {
  const ts = now();
  const recorded = eventsOfType(store.db, 'models.limit').map((e) => e.payload as unknown);
  const live = [...(recorded as LimitRecord[]), ...session];
  const exhausted = exhaustedModels(
    live,
    ts,
    session.map((l) => l.model),
  );
  if (exhausted.size === 0) return [];
  const job = getJob(store.db, id);
  const events = eventsOfTypes(store.db, id, ['models.drawn', 'models.fallback']);
  const config = loadConfig(store);
  // A fast job runs only its fast builder; a full job every other role.
  const roles = resolveRoles(config, id, drawnModelsOf(events), fallbacksOf(events)).filter(
    (r) => (r.kind === 'fast-build') === (job.mode === 'fast'),
  );
  const plan = planFallbacks(roles, config.models, exhausted);
  if (plan === null) return null;
  return plan.map((f) => {
    const why = live.findLast((l) => l.model === f.from);
    return { ...f, text: why?.text ?? '', until: why?.until ?? null };
  });
}
