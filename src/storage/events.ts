import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Db } from './client.ts';
import { events, type Event } from './schema.ts';

export function appendEvent(
  tx: Db,
  jobId: string,
  type: string,
  payload: Record<string, unknown>,
  actor: string | null,
  createdAt: string,
): void {
  tx.insert(events).values({ jobId, type, payload, actor, createdAt }).run();
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
