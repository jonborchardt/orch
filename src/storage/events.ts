import { desc, eq } from 'drizzle-orm';

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
