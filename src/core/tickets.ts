/**
 * Ticket rules: the allowed field values, the status machine, the dependency-cycle check, the
 * proposed order, and why a ticket is not ready. Pure; storage/tickets.ts applies them inside a
 * transaction and ops/tickets.ts supplies the facts that need the filesystem.
 */
import { ValidationError, WorkflowError } from './errors.ts';

export const TICKET_STATUSES = ['open', 'in-progress', 'done', 'dropped', 'duplicate'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** `question` is a decision to make, never executable work. */
export const TICKET_TYPES = ['bug', 'feature', 'chore', 'question'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
/** P1 fix now, P2 next, P3 someday, P4 parked. */
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];
/** Days of elapsed wall-clock time, start to merge; one day is 24 hours (docs/tickets.md). */
export const EFFORTS: readonly number[] = [0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2, 3, 5];
export const CLASSIFIED = ['auto', 'user'] as const;
export type Classified = (typeof CLASSIFIED)[number];
export const LINK_KINDS = ['depends_on', 'related'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface Area {
  name: string;
  description: string;
}

/** The shared areas every installation starts with; `orch ticket area add` appends more. */
export const DEFAULT_AREAS: readonly Area[] = [
  { name: 'cli', description: 'src/cli, argument parsing, text and JSON output, exit codes' },
  {
    name: 'core',
    description:
      'src/core domain rules: workflow transitions, artifact rules, ownership, roles, verification, sensitive paths, errors',
  },
  { name: 'storage', description: 'src/storage, SQLite schema, Drizzle migrations, job mutations' },
  { name: 'git', description: 'src/git, the Git runner, repo queries, worktrees' },
  {
    name: 'integrations',
    description: 'src/integrations, the Claude Code installer and the gh CLI',
  },
  {
    name: 'ops',
    description: 'src/ops, job sequencing: gates, verify, base integration, factory plan, actions',
  },
  { name: 'server', description: 'src/server, the orch ui HTTP server, API read models, status' },
  { name: 'web', description: 'web/, the React + MUI dashboard client' },
  { name: 'skills', description: 'skills/factory and agents/, the prose Claude follows' },
  {
    name: 'tests',
    description: 'tests/ and e2e/, Vitest suites, Playwright, fixtures, the gh shim',
  },
  { name: 'docs', description: 'README, docs/, decisions, CLAUDE.md' },
  {
    name: 'tooling',
    description: 'package scripts, lint, format, CI, .claude settings, local skills',
  },
  { name: 'other', description: 'nothing above fits' },
];

export const AREA_NAME = /^[a-z][a-z0-9-]*$/;

/** `85` -> `0085`, the form shown to people. */
export function ticketKey(id: number): string {
  return String(id).padStart(4, '0');
}

/** `85`, `0085`, `#85` -> 85. */
export function parseTicketId(value: unknown, what = 'ticket id'): number {
  const text = typeof value === 'number' ? String(value) : value;
  const m = typeof text === 'string' ? /^#?(\d{1,9})$/.exec(text.trim()) : null;
  const id = m ? Number(m[1]) : 0;
  if (id < 1)
    throw new ValidationError(`Bad ${what}: ${JSON.stringify(value)} (a number such as 85)`);
  return id;
}

export interface TicketFields {
  title?: string | undefined;
  type?: string | undefined;
  area?: string | undefined;
  priority?: string | undefined;
  effort?: number | undefined;
  classified?: string | undefined;
  body?: string | undefined;
}

/** Reject a value outside the allowed sets. `areas` is every known area name. */
export function validateFields(f: TicketFields, areas: readonly string[]): void {
  const oneOf = (value: string | undefined, allowed: readonly string[], name: string) => {
    if (value !== undefined && !allowed.includes(value)) {
      throw new ValidationError(`${name} must be one of ${allowed.join(', ')} (got ${value})`);
    }
  };
  if (f.title !== undefined && (!f.title.trim() || /[\r\n]/.test(f.title))) {
    throw new ValidationError('title must be one non-empty line');
  }
  oneOf(f.type, TICKET_TYPES, 'type');
  oneOf(f.priority, PRIORITIES, 'priority');
  oneOf(f.classified, CLASSIFIED, 'classified');
  oneOf(f.area, areas, 'area');
  if (f.effort !== undefined && !EFFORTS.includes(f.effort)) {
    throw new ValidationError(`effort is days, one of ${EFFORTS.join(', ')}`);
  }
}

export const LIFECYCLE_ACTIONS = ['start', 'done', 'drop', 'reopen', 'duplicate'] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

const ACTIVE: readonly TicketStatus[] = ['open', 'in-progress'];
const LIFECYCLE: Record<LifecycleAction, { from: readonly TicketStatus[]; to: TicketStatus }> = {
  start: { from: ['open'], to: 'in-progress' },
  done: { from: ACTIVE, to: 'done' },
  drop: { from: ACTIVE, to: 'dropped' },
  duplicate: { from: ACTIVE, to: 'duplicate' },
  reopen: { from: ['in-progress', 'done', 'dropped', 'duplicate'], to: 'open' },
};

/** The status `action` leads to, or a WorkflowError naming why it is not allowed from `status`. */
export function ticketTransition(status: TicketStatus, action: LifecycleAction): TicketStatus {
  const rule = LIFECYCLE[action];
  if (!rule.from.includes(status)) {
    throw new WorkflowError(
      `Cannot ${action} a ticket that is ${status} (allowed from: ${rule.from.join(', ')}).`,
    );
  }
  return rule.to;
}

/**
 * Text of every unchecked Markdown task item (`- [ ] ...`) in a ticket body, in order. A merge
 * never closes a ticket while one remains, wherever in the body it is: nothing here judges
 * whether the merged code covered it.
 */
export function uncheckedItems(body: string): string[] {
  return [...body.matchAll(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[ \][ \t]*(.*)$/gm)].map((m) =>
    (m[1] ?? '').trim(),
  );
}

/** The unchecked items (each once) approval must account for: none once the ticket is finished. */
export function openChecklist(ticket: { status: string; body: string }): string[] {
  return ticket.status === 'open' || ticket.status === 'in-progress'
    ? [...new Set(uncheckedItems(ticket.body))]
    : [];
}

/** The delimiter between an item and its reason in decision.md's Ticket checklist. */
export const CHECKLIST_DELIMITER = ' — ';

/**
 * The ticket's unchecked items (each once) that decision.md does not record as not delivered: a
 * `- [ ] <item> — <reason>` line under `## Ticket checklist` (up to the next `## ` heading), item
 * text matching exactly and a non-empty reason. A `- [x]` line there accounts for nothing: the
 * box itself must be ticked in the ticket.
 */
export function unaccountedItems(body: string, decision: string): string[] {
  const accounted = new Set(notDelivered(decision).map((l) => l.item));
  return [...new Set(uncheckedItems(body))].filter((item) => !accounted.has(item));
}

/** `- [ ] <item> — <reason>` lines (non-empty reason) under decision.md's `## Ticket checklist`. */
function notDelivered(decision: string): { item: string; reason: string }[] {
  const section = /^## Ticket checklist[ \t]*\r?$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(decision);
  const lines: { item: string; reason: string }[] = [];
  for (const line of uncheckedItems(section?.[1] ?? '')) {
    const at = line.indexOf(CHECKLIST_DELIMITER);
    const reason = at < 0 ? '' : line.slice(at + CHECKLIST_DELIMITER.length).trim();
    if (reason !== '') lines.push({ item: line.slice(0, at).trim(), reason });
  }
  return lines;
}

/**
 * Boxes decision.md hands to a follow-up ticket: a not-delivered line whose reason starts with
 * `deferred to <id>` (`0116`, `#116`, `116`), optionally followed by `: <why>`. Approval then
 * requires the box gone from the ticket body and a note naming the follow-up, so the original
 * closes on its merge (decision 2026-11-22-deferred-box-leaves-the-ticket).
 */
export function deferredItems(decision: string): { item: string; to: number }[] {
  return notDelivered(decision).flatMap(({ item, reason }) => {
    const m = /^deferred to (#?\d{1,9})(?=$|[:\s])/.exec(reason);
    const to = m ? Number(m[1]?.replace('#', '')) : 0;
    return to > 0 ? [{ item, to }] : [];
  });
}

/**
 * The path `from -> ... -> to` through existing dependencies, when there is one: adding
 * "`to` depends on `from`" would then close a cycle. `deps` maps a ticket to what it depends on.
 */
export function dependencyPath(
  deps: ReadonlyMap<number, readonly number[]>,
  from: number,
  to: number,
): number[] | undefined {
  const seen = new Set<number>();
  const walk = (id: number, path: number[]): number[] | undefined => {
    if (id === to) return [...path, id];
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const next of deps.get(id) ?? []) {
      const found = walk(next, [...path, id]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(from, []);
}

/** What ordering and readiness need to know about a ticket. */
export interface Schedulable {
  id: number;
  status: TicketStatus;
  type: TicketType;
  area: string;
  priority: Priority;
  effort: number;
  dependsOn: readonly number[];
}

/**
 * Proposed order of the open tickets: dependencies before dependents, then priority, effort,
 * area, id. An in-progress dependency is already under way, so its dependents are not held back
 * here (readiness is stricter). Kahn's algorithm, always taking the best-ranked free ticket.
 */
export function orderTickets<T extends Schedulable>(all: readonly T[]): T[] {
  const open = all.filter((t) => t.status === 'open');
  const openIds = new Set(open.map((t) => t.id));
  const cmp = (a: T, b: T) =>
    PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) ||
    a.effort - b.effort ||
    (a.area < b.area ? -1 : a.area > b.area ? 1 : 0) ||
    a.id - b.id;
  const out: T[] = [];
  const placed = new Set<number>();
  // ponytail: O(n^2) pick, fine for a personal queue; keep a heap of free tickets if it grows.
  for (;;) {
    const free = open
      .filter(
        (t) => !placed.has(t.id) && t.dependsOn.every((d) => !openIds.has(d) || placed.has(d)),
      )
      .sort(cmp);
    const next = free[0];
    if (!next) return out;
    out.push(next);
    placed.add(next.id);
  }
}

export const BLOCK_KINDS = ['dependency', 'question', 'active-job', 'repository'] as const;
export interface BlockReason {
  kind: (typeof BLOCK_KINDS)[number];
  /** The dependency's ticket id, for `dependency`. */
  ticket?: number;
  /** The unfinished job, for `active-job`. */
  job?: string;
  detail: string;
}

export interface BlockFacts {
  /** Status of each ticket this one depends on. */
  dependencies: readonly { id: number; status: TicketStatus; duplicateOf: number | null }[];
  /** Unfinished job already working on the ticket. */
  activeJob: string | null;
  /** Why the ticket's repository cannot be used here, or null when it can. */
  repoProblem: string | null;
}

/**
 * Why a ticket cannot be executed now; empty when nothing stands in the way. Only a `done`
 * dependency is satisfied: a dropped or duplicate one keeps blocking until the link is changed.
 */
export function blockReasons(ticket: Pick<Schedulable, 'type'>, facts: BlockFacts): BlockReason[] {
  const out: BlockReason[] = [];
  for (const d of facts.dependencies) {
    if (d.status === 'done') continue;
    const hint =
      d.status === 'dropped'
        ? ' (dropped: remove the dependency or reopen it)'
        : d.status === 'duplicate' && d.duplicateOf !== null
          ? ` (a duplicate of ${ticketKey(d.duplicateOf)}: depend on that instead)`
          : '';
    out.push({
      kind: 'dependency',
      ticket: d.id,
      detail: `depends on ${ticketKey(d.id)}, which is ${d.status}${hint}`,
    });
  }
  if (ticket.type === 'question') {
    out.push({ kind: 'question', detail: 'a question is a decision to make, not executable work' });
  }
  if (facts.activeJob !== null) {
    out.push({
      kind: 'active-job',
      job: facts.activeJob,
      detail: `job ${facts.activeJob} is already working on it`,
    });
  }
  if (facts.repoProblem !== null) out.push({ kind: 'repository', detail: facts.repoProblem });
  return out;
}
