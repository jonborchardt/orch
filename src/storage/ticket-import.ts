/**
 * The write half of the register import: every ticket, link, area, history row, and job
 * association of one register in a single immediate transaction. Any conflict throws before or
 * during it, so a failed import leaves nothing behind and consumes no ticket number.
 */
import { eq, inArray, max } from 'drizzle-orm';

import { ValidationError } from '../core/errors.ts';
import type { Area, Classified, Priority, TicketStatus, TicketType } from '../core/tickets.ts';
import { ticketKey } from '../core/tickets.ts';
import { now } from '../core/workflow.ts';
import type { Db, Store } from './client.ts';
import { linkJobToTicket } from './jobs.ts';
import { ticketAreas, ticketLinks, tickets } from './schema.ts';
import { appendTicketEvent, listAreas } from './tickets.ts';

export interface ImportRow {
  /** The global id the ticket gets, and its id in the register. */
  id: number;
  importId: number;
  title: string;
  status: TicketStatus;
  type: TicketType;
  area: string;
  priority: Priority;
  effort: number;
  classified: Classified;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** Already mapped to global ids. */
  dependsOn: number[];
  related: number[];
  duplicateOf: number | null;
}

export interface ImportBatch {
  source: string;
  repo: string;
  repoPath: string;
  rows: ImportRow[];
  areas: Area[];
  jobLinks: { job: string; ticket: number }[];
  actor?: string | undefined;
}

/** Register ids already imported from `source`, with the global id each one got. */
export function importedFrom(db: Db, source: string): Map<number, number> {
  const rows = db
    .select({ id: tickets.id, importId: tickets.importId })
    .from(tickets)
    .where(eq(tickets.importSource, source))
    .all();
  return new Map(rows.flatMap((r) => (r.importId === null ? [] : [[r.importId, r.id]])));
}

export function takenTicketIds(db: Db, ids: readonly number[]): number[] {
  if (ids.length === 0) return [];
  return db
    .select({ id: tickets.id })
    .from(tickets)
    .where(inArray(tickets.id, [...ids]))
    .all()
    .map((r) => r.id);
}

/** Highest ticket number handed out so far; tickets are never deleted, so the next is one more. */
export function maxTicketId(db: Db): number {
  return (
    db
      .select({ id: max(tickets.id) })
      .from(tickets)
      .get()?.id ?? 0
  );
}

/** Insert the batch, or throw and change nothing. Returns the job associations actually made. */
export function importTickets(store: Store, batch: ImportBatch): { job: string; ticket: number }[] {
  return store.db.transaction(
    (tx) => {
      if (importedFrom(tx, batch.source).size > 0) {
        throw new ValidationError(`${batch.source} was imported meanwhile. Nothing was changed.`);
      }
      const taken = takenTicketIds(
        tx,
        batch.rows.map((r) => r.id),
      );
      if (taken.length) {
        throw new ValidationError(
          `Ticket ids ${taken.map(ticketKey).join(', ')} were taken meanwhile; run the import again. Nothing was changed.`,
        );
      }
      const known = new Set(listAreas(tx).map((a) => a.name));
      for (const a of batch.areas) if (!known.has(a.name)) tx.insert(ticketAreas).values(a).run();
      const ts = now();
      // Two passes: a duplicate may point at a ticket inserted after it.
      for (const r of batch.rows) {
        tx.insert(tickets)
          .values({
            id: r.id,
            repo: batch.repo,
            repoPath: batch.repoPath,
            title: r.title,
            status: r.status,
            type: r.type,
            area: r.area,
            priority: r.priority,
            effort: r.effort,
            classified: r.classified,
            body: r.body,
            importSource: batch.source,
            importId: r.importId,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          })
          .run();
      }
      for (const r of batch.rows) {
        if (r.duplicateOf !== null) {
          tx.update(tickets).set({ duplicateOf: r.duplicateOf }).where(eq(tickets.id, r.id)).run();
        }
        for (const [kind, ids] of [
          ['depends_on', r.dependsOn],
          ['related', r.related],
        ] as const) {
          for (const targetId of new Set(ids)) {
            tx.insert(ticketLinks).values({ ticketId: r.id, targetId, kind }).run();
          }
        }
        appendTicketEvent(
          tx,
          r.id,
          {
            type: 'ticket.imported',
            payload: { source: batch.source, importId: r.importId, status: r.status },
          },
          batch.actor ?? null,
          ts,
        );
      }
      const linked = batch.jobLinks.filter((l) => linkJobToTicket(tx, l.job, l.ticket));
      for (const l of linked) {
        appendTicketEvent(
          tx,
          l.ticket,
          { type: 'ticket.job-linked', payload: { job: l.job, imported: true } },
          batch.actor ?? null,
          ts,
        );
      }
      return linked;
    },
    { behavior: 'immediate' },
  );
}
