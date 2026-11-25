/**
 * Recorded token usage, one row per Claude Code session (decision
 * 2026-11-24-recorded-token-usage). Only `src/ops/token-usage.ts` calls this module. Rows are
 * inserted once and never rewritten or deleted.
 */
import { and, eq, gte, lte } from 'drizzle-orm';

import { now } from '../core/workflow.ts';
import type { Db, Store } from './client.ts';
import { type HourUsage, tokenUsage, type TokenUsageRow } from './schema.ts';

/**
 * Store session `ref`'s per-hour counts (sorted by hour) on `jobId`. A ref already stored is
 * left as it is.
 */
export function insertUsage(
  store: Store,
  row: { ref: string; jobId: string; source: TokenUsageRow['source']; hours: HourUsage[] },
): void {
  store.db
    .insert(tokenUsage)
    .values({
      ...row,
      firstHour: row.hours[0]?.hour ?? null,
      lastHour: row.hours.at(-1)?.hour ?? null,
      recordedAt: now(),
    })
    .onConflictDoNothing()
    .run();
}

/** Every recorded session ref. */
export function recordedRefs(db: Db): Set<string> {
  return new Set(
    db
      .select({ ref: tokenUsage.ref })
      .from(tokenUsage)
      .all()
      .map((r) => r.ref),
  );
}

/** Rows holding at least one hour that may fall in `[first, last]` (epoch ms, inclusive). */
export function usageInRange(db: Db, first: number, last: number): TokenUsageRow[] {
  return db
    .select()
    .from(tokenUsage)
    .where(and(gte(tokenUsage.lastHour, first), lte(tokenUsage.firstHour, last)))
    .all();
}

/** Every recorded session of `jobId`. */
export function usageOfJob(db: Db, jobId: string): TokenUsageRow[] {
  return db.select().from(tokenUsage).where(eq(tokenUsage.jobId, jobId)).all();
}
