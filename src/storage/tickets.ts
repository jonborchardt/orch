/**
 * Every ticket mutation goes through here: one immediate transaction that loads the ticket,
 * checks the caller's revision, applies a rule from core/tickets.ts, bumps the revision, and
 * appends history. Ticket numbers come from SQLite's AUTOINCREMENT, so concurrent CLI processes
 * never share or reuse one. Tickets are never deleted.
 */
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';

import { NotFoundError, OwnershipError, ValidationError, WorkflowError } from '../core/errors.ts';
import {
  type Area,
  AREA_NAME,
  type BlockFacts,
  blockReasons,
  type Classified,
  DEFAULT_AREAS,
  dependencyPath,
  type LifecycleAction,
  type LinkKind,
  type MoveTo,
  planMove,
  type Priority,
  type TicketFields,
  ticketKey,
  type TicketStatus,
  ticketTransition,
  type TicketType,
  uncheckedItems,
  validateFields,
} from '../core/tickets.ts';
import { now, TERMINAL_STATUSES } from '../core/workflow.ts';
import type { Db, Store } from './client.ts';
import {
  type Job,
  jobs,
  type Ticket,
  ticketAreas,
  type TicketEvent,
  ticketEvents,
  ticketLinks,
  tickets,
} from './schema.ts';

/** A ticket with its outgoing links. */
export interface LinkedTicket extends Ticket {
  dependsOn: number[];
  related: number[];
}

export interface TicketWrite {
  /** Optimistic concurrency: reject when the ticket's revision differs. */
  expectRevision?: number | undefined;
  actor?: string | undefined;
}

interface TicketEventInput {
  type: string;
  payload: Record<string, unknown>;
}

export function listAreas(db: Db): Area[] {
  return [...DEFAULT_AREAS, ...db.select().from(ticketAreas).orderBy(ticketAreas.name).all()];
}

export function addArea(store: Store, area: Area): Area[] {
  if (!AREA_NAME.test(area.name)) throw new ValidationError('area name must be kebab-case');
  if (!area.description.trim()) throw new ValidationError('area needs a description');
  return store.db.transaction(
    (tx) => {
      if (listAreas(tx).some((a) => a.name === area.name)) {
        throw new ValidationError(`area ${area.name} already exists`);
      }
      tx.insert(ticketAreas).values(area).run();
      return listAreas(tx);
    },
    { behavior: 'immediate' },
  );
}

export function appendTicketEvent(
  tx: Db,
  ticketId: number,
  e: TicketEventInput,
  actor: string | null,
  createdAt: string,
): void {
  tx.insert(ticketEvents)
    .values({ ticketId, ...e, actor, createdAt })
    .run();
}

export function getTicket(db: Db, id: number): Ticket {
  const ticket = db.select().from(tickets).where(eq(tickets.id, id)).get();
  if (!ticket) throw new NotFoundError(`No ticket ${ticketKey(id)}`);
  return ticket;
}

function linksOf(db: Db, id: number, kind: LinkKind): number[] {
  return db
    .select({ id: ticketLinks.targetId })
    .from(ticketLinks)
    .where(and(eq(ticketLinks.ticketId, id), eq(ticketLinks.kind, kind)))
    .orderBy(ticketLinks.targetId)
    .all()
    .map((r) => r.id);
}

export function getLinkedTicket(db: Db, id: number): LinkedTicket {
  return {
    ...getTicket(db, id),
    dependsOn: linksOf(db, id, 'depends_on'),
    related: linksOf(db, id, 'related'),
  };
}

/** Every ticket with its links, by id. ponytail: loads the whole queue; page in SQL if it gets large. */
export function allTickets(db: Db): LinkedTicket[] {
  const byId = new Map<number, LinkedTicket>(
    db
      .select()
      .from(tickets)
      .orderBy(tickets.id)
      .all()
      .map((t) => [t.id, { ...t, dependsOn: [], related: [] }]),
  );
  const links = db
    .select()
    .from(ticketLinks)
    .orderBy(ticketLinks.ticketId, ticketLinks.targetId)
    .all();
  for (const l of links) {
    byId.get(l.ticketId)?.[l.kind === 'depends_on' ? 'dependsOn' : 'related'].push(l.targetId);
  }
  return [...byId.values()];
}

/** Tickets that name `id` as a dependency. */
export function dependentsOf(db: Db, id: number): number[] {
  return db
    .select({ id: ticketLinks.ticketId })
    .from(ticketLinks)
    .where(and(eq(ticketLinks.targetId, id), eq(ticketLinks.kind, 'depends_on')))
    .orderBy(ticketLinks.ticketId)
    .all()
    .map((r) => r.id);
}

/** Newest last. */
export function listTicketEvents(db: Db, id: number, limit = 200): TicketEvent[] {
  getTicket(db, id);
  return db
    .select()
    .from(ticketEvents)
    .where(eq(ticketEvents.ticketId, id))
    .orderBy(desc(ticketEvents.id))
    .limit(limit)
    .all()
    .reverse();
}

/** Every job that ever worked on the ticket, oldest first. */
export function ticketJobs(db: Db, id: number): Job[] {
  getTicket(db, id);
  return db.select().from(jobs).where(eq(jobs.ticketId, id)).orderBy(asc(jobs.createdAt)).all();
}

/** The unfinished job of each ticket that has one. */
export function activeJobsByTicket(db: Db): Map<number, string> {
  const rows = db
    .select({ id: jobs.id, ticketId: jobs.ticketId })
    .from(jobs)
    .where(notInArray(jobs.status, [...TERMINAL_STATUSES]))
    .all();
  return new Map(rows.flatMap((r) => (r.ticketId === null ? [] : [[r.ticketId, r.id]])));
}

function activeJobOf(db: Db, id: number): string | null {
  return (
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.ticketId, id), notInArray(jobs.status, [...TERMINAL_STATUSES])))
      .get()?.id ?? null
  );
}

function requireTickets(tx: Db, ids: readonly number[], what: string): void {
  if (ids.length === 0) return;
  const found = new Set(
    tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(inArray(tickets.id, [...ids]))
      .all()
      .map((r) => r.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new ValidationError(`${what} names ${missing.map(ticketKey).join(', ')}: no such ticket`);
  }
}

function dependencyMap(tx: Db): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const rows = tx.select().from(ticketLinks).where(eq(ticketLinks.kind, 'depends_on')).all();
  for (const l of rows) map.set(l.ticketId, [...(map.get(l.ticketId) ?? []), l.targetId]);
  return map;
}

export interface CreateTicketInput extends TicketFields {
  title: string;
  repo: string;
  repoPath: string;
  dependsOn?: readonly number[] | undefined;
  related?: readonly number[] | undefined;
  actor?: string | undefined;
}

export function createTicket(store: Store, input: CreateTicketInput): LinkedTicket {
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  const related = [...new Set(input.related ?? [])];
  return store.db.transaction(
    (tx) => {
      validateFields(
        input,
        listAreas(tx).map((a) => a.name),
      );
      requireTickets(tx, dependsOn, 'depends-on');
      requireTickets(tx, related, 'related');
      const ts = now();
      const row = tx
        .insert(tickets)
        .values({
          repo: input.repo,
          repoPath: input.repoPath,
          title: input.title.trim(),
          status: 'open',
          type: (input.type ?? 'feature') as TicketType,
          area: input.area ?? 'other',
          priority: (input.priority ?? 'P3') as Priority,
          effort: input.effort ?? 1,
          classified: (input.classified ?? 'auto') as Classified,
          body: input.body ?? '',
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
      // A new ticket has no dependents, so its dependencies cannot close a cycle.
      for (const [kind, ids] of [
        ['depends_on', dependsOn],
        ['related', related],
      ] as const) {
        for (const targetId of ids)
          tx.insert(ticketLinks).values({ ticketId: row.id, targetId, kind }).run();
      }
      appendTicketEvent(
        tx,
        row.id,
        {
          type: 'ticket.created',
          payload: { title: row.title, repo: row.repo, dependsOn, related },
        },
        input.actor ?? null,
        ts,
      );
      return { ...row, dependsOn, related };
    },
    { behavior: 'immediate' },
  );
}

interface TicketDecision {
  patch: Partial<Ticket>;
  events: TicketEventInput[];
}

function checkRevision(ticket: Ticket, w: TicketWrite): void {
  if (w.expectRevision !== undefined && w.expectRevision !== ticket.revision) {
    throw new OwnershipError(
      `Stale revision: expected ${String(w.expectRevision)}, ticket ${ticketKey(ticket.id)} is at ${String(ticket.revision)}.`,
    );
  }
}

/** Revision-checked, revision-bumping transaction around one decision about a ticket. */
function mutateTicket(
  store: Store,
  id: number,
  w: TicketWrite,
  decide: (ticket: Ticket, tx: Db) => TicketDecision,
): LinkedTicket {
  return store.db.transaction(
    (tx) => {
      const ticket = getTicket(tx, id);
      checkRevision(ticket, w);
      const { patch, events } = decide(ticket, tx);
      applyTicket(tx, ticket, patch, events, w.actor ?? null, now());
      return getLinkedTicket(tx, id);
    },
    { behavior: 'immediate' },
  );
}

function applyTicket(
  tx: Db,
  ticket: Ticket,
  patch: Partial<Ticket>,
  events: readonly TicketEventInput[],
  actor: string | null,
  ts: string,
): void {
  tx.update(tickets)
    .set({ ...patch, revision: ticket.revision + 1, updatedAt: ts })
    .where(eq(tickets.id, ticket.id))
    .run();
  for (const e of events) appendTicketEvent(tx, ticket.id, e, actor, ts);
}

export interface EditTicketInput extends TicketFields {
  /** Re-associate the ticket with another checkout (resolved by ops/tickets.ts). */
  repo?: string | undefined;
  repoPath?: string | undefined;
  /** A finite number, or null to unrank (checked by ops/tickets.ts). */
  rank?: number | null | undefined;
}

const CLASSIFICATION = ['type', 'area', 'effort', 'classified'] as const;

/**
 * Change fields. History records old and new values, except the body, which is only marked as
 * changed. A priority change and a rank change are each their own event; type, area, effort,
 * and classified are one `ticket.reclassified`.
 */
export function editTicket(
  store: Store,
  id: number,
  input: EditTicketInput,
  w: TicketWrite = {},
): LinkedTicket {
  return mutateTicket(store, id, w, (ticket, tx) => {
    validateFields(
      input,
      listAreas(tx).map((a) => a.name),
    );
    const next: Partial<Ticket> = {};
    const changes = (keys: readonly (keyof Ticket & keyof EditTicketInput)[]) => {
      const out: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of keys) {
        const to = k === 'title' ? input.title?.trim() : input[k];
        if (to === undefined || to === ticket[k]) continue;
        out[k] = { from: ticket[k], to };
        Object.assign(next, { [k]: to });
      }
      return out;
    };
    const events: TicketEventInput[] = [];
    const edited: Record<string, unknown> = changes(['title', 'repo', 'repoPath']);
    if (input.body !== undefined && input.body !== ticket.body) {
      next.body = input.body;
      edited['body'] = { bytes: Buffer.byteLength(input.body) };
    }
    if (Object.keys(edited).length) events.push({ type: 'ticket.edited', payload: edited });
    const reclassified = changes(CLASSIFICATION);
    if (Object.keys(reclassified).length) {
      events.push({ type: 'ticket.reclassified', payload: reclassified });
    }
    const priority = changes(['priority'])['priority'];
    if (priority) events.push({ type: 'ticket.priority-changed', payload: priority });
    const rank = changes(['rank'])['rank'];
    if (rank) events.push({ type: 'ticket.rank-changed', payload: rank });
    if (events.length === 0) throw new ValidationError('Nothing to change.');
    return { patch: next, events };
  });
}

/**
 * Move open ticket `id` in the global order (core/tickets.ts `planMove`): every rank write, each
 * bumping that ticket's revision with its own `ticket.rank-changed`, in one transaction.
 * `w.expectRevision` guards the moved ticket only. A refusal writes nothing.
 */
export function moveTicket(
  store: Store,
  id: number,
  to: MoveTo,
  w: TicketWrite = {},
): LinkedTicket {
  return store.db.transaction(
    (tx) => {
      const ticket = getTicket(tx, id);
      checkRevision(ticket, w);
      if (typeof to === 'object' && 'before' in to) getTicket(tx, to.before);
      const all = allTickets(tx);
      const ts = now();
      for (const { id: other, rank } of planMove(all, id, to)) {
        const row = getTicket(tx, other);
        const event = { type: 'ticket.rank-changed', payload: { from: row.rank, to: rank } };
        applyTicket(tx, row, { rank }, [event], w.actor ?? null, ts);
      }
      return getLinkedTicket(tx, id);
    },
    { behavior: 'immediate' },
  );
}

const LIFECYCLE_EVENT: Record<LifecycleAction, string> = {
  start: 'ticket.started',
  done: 'ticket.completed',
  drop: 'ticket.dropped',
  reopen: 'ticket.reopened',
  duplicate: 'ticket.duplicate-marked',
};

export interface LifecycleInput extends TicketWrite {
  /** The ticket this one duplicates; required for `duplicate`. */
  of?: number | undefined;
  note?: string | undefined;
}

/**
 * Move a ticket through its status machine. A ticket is not closed while a job is still working
 * on it (finish or cancel the job first), and never by a job finishing: closing is this explicit
 * call.
 */
export function ticketLifecycle(
  store: Store,
  id: number,
  action: LifecycleAction,
  input: LifecycleInput = {},
): LinkedTicket {
  return mutateTicket(store, id, input, (ticket, tx) => {
    const to = ticketTransition(ticket.status, action);
    const patch: Partial<Ticket> = { status: to, duplicateOf: null };
    if (action !== 'start' && action !== 'reopen') {
      const job = activeJobOf(tx, id);
      if (job !== null) {
        throw new WorkflowError(
          `Job ${job} is still working on ticket ${ticketKey(id)}; let it finish or cancel it first.`,
        );
      }
    }
    if (action === 'duplicate') {
      if (input.of === undefined)
        throw new ValidationError('duplicate needs the ticket it duplicates');
      if (input.of === id) throw new ValidationError('A ticket cannot duplicate itself.');
      const original = getTicket(tx, input.of);
      if (original.status === 'duplicate') {
        throw new ValidationError(
          `${ticketKey(input.of)} is itself a duplicate of ${ticketKey(original.duplicateOf ?? 0)}; point at that.`,
        );
      }
      patch.duplicateOf = input.of;
    }
    return {
      patch,
      events: [
        {
          type: LIFECYCLE_EVENT[action],
          payload: {
            from: ticket.status,
            to,
            of: patch.duplicateOf ?? undefined,
            note: input.note,
          },
        },
      ],
    };
  });
}

/**
 * Add or remove "`id` depends on `target`" or "`id` is related to `target`". A dependency on
 * itself, on a missing ticket, or one that would close a cycle is refused.
 */
export function setTicketLink(
  store: Store,
  id: number,
  target: number,
  kind: LinkKind,
  add: boolean,
  w: TicketWrite = {},
): LinkedTicket {
  return mutateTicket(store, id, w, (_ticket, tx) => {
    const key = and(
      eq(ticketLinks.ticketId, id),
      eq(ticketLinks.targetId, target),
      eq(ticketLinks.kind, kind),
    );
    const exists = tx.select().from(ticketLinks).where(key).get() !== undefined;
    const name = kind === 'depends_on' ? 'dependency' : 'related';
    if (add) {
      if (target === id) throw new ValidationError(`A ticket cannot be its own ${name}.`);
      requireTickets(tx, [target], name);
      if (exists) throw new ValidationError(`${ticketKey(id)} already has that ${name}.`);
      if (kind === 'depends_on') {
        const path = dependencyPath(dependencyMap(tx), target, id);
        if (path) {
          throw new ValidationError(
            `Dependency cycle: ${[id, ...path].map(ticketKey).join(' -> ')}. Nothing was changed.`,
          );
        }
      }
      tx.insert(ticketLinks).values({ ticketId: id, targetId: target, kind }).run();
    } else {
      if (!exists) throw new ValidationError(`${ticketKey(id)} has no such ${name}.`);
      tx.delete(ticketLinks).where(key).run();
    }
    return {
      patch: {},
      events: [
        { type: `ticket.${name}-${add ? 'added' : 'removed'}`, payload: { ticket: target } },
      ],
    };
  });
}

/** Append a dated note to the ticket's history. */
export function addTicketNote(
  store: Store,
  id: number,
  text: string,
  w: TicketWrite = {},
): LinkedTicket {
  if (!text.trim()) throw new ValidationError('A note needs text.');
  return recordTicketEvent(store, id, { type: 'ticket.note', payload: { text: text.trim() } }, w);
}

/** Append one history row (a note, an attached asset) and bump the revision. */
export function recordTicketEvent(
  store: Store,
  id: number,
  event: TicketEventInput,
  w: TicketWrite = {},
): LinkedTicket {
  return mutateTicket(store, id, w, () => ({ patch: {}, events: [event] }));
}

/** What the scheduler rules need about `id`'s dependencies and jobs; the repository is the caller's to judge. */
export function blockFacts(db: Db, ticket: LinkedTicket | Ticket): Omit<BlockFacts, 'repoProblem'> {
  const deps = 'dependsOn' in ticket ? ticket.dependsOn : linksOf(db, ticket.id, 'depends_on');
  return {
    dependencies: deps.map((d) => {
      const t = getTicket(db, d);
      return { id: d, status: t.status, duplicateOf: t.duplicateOf };
    }),
    activeJob: activeJobOf(db, ticket.id),
  };
}

/**
 * Inside the transaction that inserts job `jobId`: check the ticket may be worked on (open or
 * already in progress, not a question, every dependency done, no other unfinished job), mark it
 * in progress, and record the association. Throws, so the job insert rolls back with it.
 */
export function claimTicketForJob(
  tx: Db,
  ticketId: number,
  job: { id: string; repo: string; repoPath: string },
  actor: string | null,
  ts: string,
): void {
  const ticket = getTicket(tx, ticketId);
  const key = ticketKey(ticketId);
  if (ticket.status !== 'open' && ticket.status !== 'in-progress') {
    throw new WorkflowError(
      `Ticket ${key} is ${ticket.status}; only an open or in-progress ticket gets a job.`,
    );
  }
  const reasons = blockReasons(ticket, { ...blockFacts(tx, ticket), repoProblem: null });
  if (reasons.length) {
    throw new WorkflowError(
      `Ticket ${key} cannot be started: ${reasons.map((r) => r.detail).join('; ')}. Nothing was created.`,
    );
  }
  const events: TicketEventInput[] = [];
  const patch: Partial<Ticket> = {};
  if (ticket.status === 'open') {
    patch.status = 'in-progress' satisfies TicketStatus;
    events.push({
      type: 'ticket.started',
      payload: { from: 'open', to: 'in-progress', job: job.id },
    });
  }
  // The job was resolved from the ticket's own checkout: a remote added or re-pointed since the
  // ticket was filed shows up here as a new identity.
  if (ticket.repo !== job.repo) {
    patch.repo = job.repo;
    events.push({ type: 'ticket.edited', payload: { repo: { from: ticket.repo, to: job.repo } } });
  }
  events.push({ type: 'ticket.job-linked', payload: { job: job.id } });
  applyTicket(tx, ticket, patch, events, actor, ts);
}

/**
 * Inside the transaction that cancels `jobId`: return its ticket to `open` when the ticket is
 * still in progress, so a cancelled job never strands its ticket. `jobs_active_ticket_idx` makes
 * the cancelled job the ticket's only unfinished one. Any other ticket is left as it is.
 */
export function releaseTicketForCancel(
  tx: Db,
  ticketId: number,
  jobId: string,
  reason: string | undefined,
  actor: string | null,
  ts: string,
): void {
  const ticket = getTicket(tx, ticketId);
  if (ticket.status !== 'in-progress') return;
  const note = `job ${jobId} was cancelled${reason ? `: ${reason}` : ''}`;
  const event = {
    type: 'ticket.reopened',
    payload: { from: 'in-progress', to: 'open', job: jobId, note },
  };
  applyTicket(tx, ticket, { status: 'open' }, [event], actor, ts);
}

/** A job's PR that GitHub reports merged, as the ticket needs to know it. */
export interface TicketMerge {
  job: Pick<Job, 'id' | 'supersededBy'>;
  prUrl: string;
  /** The PR head GitHub merged. */
  head: string | null;
  mergeCommit: string;
  /** The merged head is the one the job's passing CI verdict was recorded for. */
  verified: boolean;
  /** Why not, when `verified` is false. */
  reason: string | null;
}

export interface TicketMergeOutcome {
  id: number;
  status: TicketStatus;
  /** The ticket is done after this call (by this merge now or earlier, or by someone else). */
  completed: boolean;
  /** Why the merge did not close it; null when it is done. */
  reason: string | null;
  /** Unchecked checklist items that keep it open. */
  remaining: string[];
  /** This call wrote to the ticket (or would, when planning). */
  changed: boolean;
}

/**
 * Inside the transaction that records a job's merge: close the job's ticket when the merge was
 * verified, the job was not superseded, no other job is working on the ticket, and no checklist
 * item is unchecked; otherwise leave its status alone and record once why (`ticket.job-merged`).
 * A ticket someone already closed, dropped, or marked duplicate is never touched. Safe to repeat:
 * the same state writes nothing the second time. `write: false` only reports what would happen.
 */
export function settleTicketForMerge(
  tx: Db,
  ticketId: number,
  m: TicketMerge,
  actor: string | null,
  ts: string,
  write = true,
): TicketMergeOutcome {
  const ticket = getTicket(tx, ticketId);
  const out = (o: Partial<TicketMergeOutcome>): TicketMergeOutcome => ({
    id: ticketId,
    status: ticket.status,
    completed: false,
    reason: null,
    remaining: [],
    changed: false,
    ...o,
  });
  if (ticket.status === 'done') return out({ completed: true });
  if (ticket.status !== 'open' && ticket.status !== 'in-progress') {
    return out({ reason: `ticket ${ticketKey(ticketId)} is ${ticket.status}; left as it is` });
  }
  const other = activeJobOf(tx, ticketId);
  const remaining = uncheckedItems(ticket.body);
  const reason = !m.verified
    ? (m.reason ?? 'the merged head is not the verified one')
    : m.job.supersededBy !== null
      ? `job ${m.job.id} was superseded by ${m.job.supersededBy}`
      : other !== null
        ? `job ${other} is still working on the ticket`
        : remaining.length > 0
          ? `${String(remaining.length)} unchecked checklist item(s) remain: ${remaining.join('; ')}`
          : null;
  const evidence = { job: m.job.id, prUrl: m.prUrl, head: m.head, mergeCommit: m.mergeCommit };
  if (reason === null) {
    const event = {
      type: 'ticket.completed',
      payload: {
        from: ticket.status,
        to: 'done',
        ...evidence,
        note: `merged ${m.prUrl} (job ${m.job.id})`,
      },
    };
    if (write) applyTicket(tx, ticket, { status: 'done', duplicateOf: null }, [event], actor, ts);
    return out({ status: 'done', completed: true, changed: true });
  }
  // Said once per reason: a retry with nothing new to say leaves the history alone.
  const said = tx
    .select()
    .from(ticketEvents)
    .where(and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.type, 'ticket.job-merged')))
    .all()
    .some((e) => e.payload['job'] === m.job.id && e.payload['reason'] === reason);
  const listed = m.verified && other === null && m.job.supersededBy === null ? remaining : [];
  if (!said && write) {
    const payload = { ...evidence, verified: m.verified, reason, remaining: listed };
    applyTicket(tx, ticket, {}, [{ type: 'ticket.job-merged', payload }], actor, ts);
  }
  return out({ reason, remaining: listed, changed: !said });
}
