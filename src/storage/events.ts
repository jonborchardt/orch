import { and, desc, eq, gt, inArray, max } from 'drizzle-orm';

import type { Db } from './client.ts';
import { events, type Event } from './schema.ts';

export function appendEvent(
  tx: Db,
  jobId: string,
  type: string,
  payload: Record<string, unknown>,
  actor: string | null,
  createdAt: string,
): number {
  return tx
    .insert(events)
    .values({ jobId, type, payload, actor, createdAt })
    .returning({ id: events.id })
    .get().id;
}

/** Newest last. */
export function listEvents(db: Db, jobId: string, limit = 100): Event[] {
  return db
    .select()
    .from(events)
    .where(eq(events.jobId, jobId))
    .orderBy(desc(events.id))
    .limit(limit)
    .all()
    .reverse();
}

/** Every event of the listed types for one job, newest first. */
export function eventsOfTypes(db: Db, jobId: string, types: readonly string[]): Event[] {
  return db
    .select()
    .from(events)
    .where(and(eq(events.jobId, jobId), inArray(events.type, [...types])))
    .orderBy(desc(events.id))
    .all();
}

/** Newest event of each listed type per job, for a board that explains jobs without N queries. */
export function latestEventsByJob(
  db: Db,
  jobIds: readonly string[],
  types: readonly string[],
): Map<string, Map<string, Event>> {
  const out = new Map<string, Map<string, Event>>(jobIds.map((id) => [id, new Map()]));
  if (jobIds.length === 0 || types.length === 0) return out;
  const rows = db
    .select()
    .from(events)
    .where(and(inArray(events.jobId, [...jobIds]), inArray(events.type, [...types])))
    .orderBy(events.id)
    .all();
  for (const e of rows) out.get(e.jobId)?.set(e.type, e);
  return out;
}

/** Highest event id so far (0 for an empty log): the watermark a mail report starts after. */
export function maxEventId(db: Db): number {
  return (
    db
      .select({ id: max(events.id) })
      .from(events)
      .get()?.id ?? 0
  );
}

/** Ids of the jobs with an event of one of `types` after event `afterId`. */
export function jobsWithEventsAfter(db: Db, afterId: number, types: readonly string[]): string[] {
  const rows = db
    .selectDistinct({ jobId: events.jobId })
    .from(events)
    .where(and(gt(events.id, afterId), inArray(events.type, [...types])))
    .all();
  return rows.map((r) => r.jobId);
}

/** A job's events of one of `types` after event `afterId`, oldest first. */
export function eventsAfter(
  db: Db,
  jobId: string,
  afterId: number,
  types: readonly string[],
): Event[] {
  return db
    .select()
    .from(events)
    .where(and(eq(events.jobId, jobId), gt(events.id, afterId), inArray(events.type, [...types])))
    .orderBy(events.id)
    .all();
}
