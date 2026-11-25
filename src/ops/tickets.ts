/**
 * Ticket operations shared by `orch ticket` and the HTTP API: both hand in loosely typed input
 * (flags, JSON) and get the same parsing, repository resolution, and views. Rules live in
 * core/tickets.ts and are applied by storage/tickets.ts; this layer adds what needs Git or the
 * filesystem: which repository a ticket belongs to and whether it is available here.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

import { NotFoundError, ValidationError } from '../core/errors.ts';
import { findProjectRoot, ticketAssetDir } from '../core/paths.ts';
import {
  type Area,
  type BlockReason,
  blockReasons,
  LIFECYCLE_ACTIONS,
  type LifecycleAction,
  type MoveTo,
  orderTickets,
  parseTicketId,
  PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  ticketKey,
} from '../core/tickets.ts';
import type { Store } from '../storage/client.ts';
import type { Job, Ticket, TicketEvent } from '../storage/schema.ts';
import {
  activeJobsByTicket,
  addArea,
  addTicketNote,
  allTickets,
  createTicket,
  dependentsOf,
  editTicket,
  getLinkedTicket,
  getTicket,
  type LinkedTicket,
  listAreas,
  listTicketEvents,
  moveTicket,
  recordTicketEvent,
  setTicketLink,
  ticketJobs,
  ticketLifecycle,
} from '../storage/tickets.ts';
import { commonGitDirWithin } from '../git/repo.ts';
import { buildReceipt, receiptMarkdown } from './receipt.ts';
import { inRepositoryAt, jobRepository } from './repo.ts';

export interface TicketView extends LinkedTicket {
  /** Zero-padded id, as shown to people (`0085`). */
  key: string;
  /** Open, and nothing in `blockedBy`. */
  ready: boolean;
  /** Why an open ticket cannot be executed now; empty for every other status. */
  blockedBy: BlockReason[];
  /** The unfinished job working on it. */
  activeJob: string | null;
}
/** A list row: the view without the Markdown body. */
export type TicketSummary = Omit<TicketView, 'body'>;

export const TICKET_VIEWS = ['all', 'order', 'ready', 'blocked'] as const;
export type TicketListView = (typeof TICKET_VIEWS)[number];

type Raw = Record<string, unknown>;

function text(raw: Raw, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${key} must be a string`);
  return v;
}

function count(raw: Raw, key: string, min: number): number | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min) {
    throw new ValidationError(`${key} must be an integer of at least ${String(min)}`);
  }
  return n;
}

function effort(raw: Raw): number | undefined {
  const v = raw['effort'];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || Number.isNaN(n))
    throw new ValidationError('effort must be a number of days');
  return n;
}

/** A finite number; null, `null`, or `none` unranks; absent leaves the rank alone. */
function rank(raw: Raw): number | null | undefined {
  const v = raw['rank'];
  if (v === undefined) return undefined;
  if (v === null || v === 'none' || v === 'null') return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new ValidationError(
      `rank must be a number, or none to unrank (got ${JSON.stringify(v)})`,
    );
  }
  return n;
}

/** Exactly one of `up`, `down`, `top` (true), `before` (a ticket id), or `position` (1-based). */
function moveTo(raw: Raw): MoveTo {
  const flags = (['up', 'down', 'top'] as const).filter(
    (k) => raw[k] === true || raw[k] === 'true',
  );
  const before = raw['before'] ?? undefined;
  const position = count(raw, 'position', 1);
  if (flags.length + (before === undefined ? 0 : 1) + (position === undefined ? 0 : 1) !== 1) {
    throw new ValidationError('move takes exactly one of up, down, top, before, or position');
  }
  if (position !== undefined) return { position };
  return before === undefined ? (flags[0] as MoveTo) : { before: parseTicketId(before, 'before') };
}

/** `[62, 74]`, `"62,74"`, `"0062 0074"` -> ids. */
function idList(raw: Raw, key: string): number[] | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  const parts: unknown[] = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(/[\s,]+/).filter(Boolean)
      : [v];
  return parts.map((p) => parseTicketId(p, key));
}

function fields(raw: Raw) {
  return {
    title: text(raw, 'title'),
    type: text(raw, 'type'),
    area: text(raw, 'area'),
    priority: text(raw, 'priority')?.toUpperCase(),
    effort: effort(raw),
    classified: text(raw, 'classified'),
    body: text(raw, 'body'),
  };
}

function write(raw: Raw) {
  return { expectRevision: count(raw, 'revision', 1), actor: text(raw, 'actor') };
}

/** The repository a ticket filed from `path` belongs to: its primary checkout, also from a worktree. */
function ticketRepository(path: string): { repo: string; repoPath: string } {
  if (!existsSync(path) || findProjectRoot(path) === undefined) {
    throw new ValidationError(
      `${path} is not inside a Git repository. A ticket belongs to a repository: pass --repo <path>.`,
    );
  }
  const { repo } = jobRepository(path);
  return { repo: repo.identity, repoPath: repo.root };
}

/** Total time one ticket read may spend asking Git about recorded checkouts. */
export const REPO_CHECK_BUDGET_MS = 2000;
/** How long a checkout whose Git lookup timed out is reported as timed out without asking again. */
export const REPO_TIMEOUT_TTL_MS = 60_000;
// ponytail: per-process memo of timed-out checkouts only (path -> expiry); not shared between
// processes, and successful or missing results are recomputed on every call.
const timedOutUntil = new Map<string, number>();

/**
 * Why a ticket's recorded checkout cannot be used here, memoized per distinct `repoPath` for one
 * call. The call's Git lookups share `REPO_CHECK_BUDGET_MS`, so one hung checkout cannot stall a
 * polled ticket list; a timed-out or unchecked checkout blocks its tickets, never readies them.
 * `lookup` and `now` exist for tests.
 */
export function repoProblemOf(
  lookup: typeof commonGitDirWithin = commonGitDirWithin,
  now: () => number = Date.now,
): (t: Pick<Ticket, 'repoPath'>) => string | null {
  const seen = new Map<string, string | null>();
  const start = now();
  const timedOut = (p: string): string =>
    `its repository checkout ${p} did not answer Git in time (checked again ${String(REPO_TIMEOUT_TTL_MS / 1000)} s after the timeout)`;
  const check = (p: string): string | null => {
    const until = timedOutUntil.get(p);
    if (until !== undefined && now() < until) return timedOut(p);
    timedOutUntil.delete(p);
    const missing = `its repository checkout ${p} is not available here (restore it, or orch ticket edit <id> --repo <path>)`;
    if (!existsSync(p)) return missing;
    const remaining = REPO_CHECK_BUDGET_MS - (now() - start);
    if (remaining <= 0) {
      return `its repository checkout ${p} was not checked: this read ran out of time on other checkouts`;
    }
    const key = lookup(p, remaining);
    if (typeof key === 'object') {
      timedOutUntil.set(p, now() + REPO_TIMEOUT_TTL_MS);
      return timedOut(p);
    }
    return key === undefined ? missing : null;
  };
  return (t) => {
    if (!seen.has(t.repoPath)) seen.set(t.repoPath, check(t.repoPath));
    return seen.get(t.repoPath) ?? null;
  };
}

/** Every ticket as a view, by id. */
function views(store: Store): TicketView[] {
  const all = allTickets(store.db);
  const byId = new Map(all.map((t) => [t.id, t]));
  const active = activeJobsByTicket(store.db);
  const repoProblem = repoProblemOf();
  return all.map((t) => {
    const activeJob = active.get(t.id) ?? null;
    const blockedBy =
      t.status === 'open'
        ? blockReasons(t, {
            dependencies: t.dependsOn.flatMap((d) => {
              const dep = byId.get(d);
              return dep ? [{ id: d, status: dep.status, duplicateOf: dep.duplicateOf }] : [];
            }),
            activeJob,
            repoProblem: repoProblem(t),
          })
        : [];
    return {
      ...t,
      key: ticketKey(t.id),
      ready: t.status === 'open' && blockedBy.length === 0,
      blockedBy,
      activeJob,
    };
  });
}

function viewOf(store: Store, id: number): TicketView {
  const found = views(store).find((t) => t.id === id);
  if (!found) throw new NotFoundError(`No ticket ${ticketKey(id)}`);
  return found;
}

/**
 * `--repo`: a path (absolute, or with a separator or a leading dot) selects that repository
 * (and clones of its remote); anything else is an
 * identity (`github.com/o/r`) or its last segment (`r`), which must name one repository.
 */
function repoFilter(all: readonly TicketView[], value: string): (t: TicketView) => boolean {
  // A bare word is a name even when a directory of that name happens to sit in the cwd.
  const pathLike = isAbsolute(value) || value.startsWith('.') || /[\\/]/.test(value);
  if (pathLike && existsSync(value) && findProjectRoot(value) !== undefined) {
    return inRepositoryAt(value);
  }
  const name = value.toLowerCase();
  const matches = new Set(
    all.map((t) => t.repo).filter((r) => r === name || r.endsWith(`/${name}`)),
  );
  if (matches.size > 1) {
    throw new ValidationError(
      `--repo ${value} matches several repositories: ${[...matches].join(', ')}. Name one in full.`,
    );
  }
  return (t) => matches.has(t.repo);
}

export interface TicketList {
  /** Matches before `limit`/`offset`. */
  total: number;
  tickets: TicketSummary[];
}

/**
 * Tickets across every repository unless `repo` narrows it. `all` is by id; `order` is the
 * proposed order of the open tickets; `ready` and `blocked` are that order split by whether
 * anything stands in the way. Reading never claims or starts anything.
 */
export function listTickets(store: Store, raw: Raw = {}): TicketList {
  const view = (text(raw, 'view') ?? 'all') as TicketListView;
  const check = (key: string, allowed: readonly string[]) => {
    const v = key === 'priority' ? text(raw, key)?.toUpperCase() : text(raw, key);
    if (v !== undefined && !allowed.includes(v)) {
      throw new ValidationError(`${key} must be one of ${allowed.join(', ')}`);
    }
    return v;
  };
  check('view', TICKET_VIEWS);
  const status = check('status', TICKET_STATUSES);
  const priority = check('priority', PRIORITIES);
  const type = check('type', TICKET_TYPES);
  const area = text(raw, 'area');
  const repo = text(raw, 'repo');
  const limit = count(raw, 'limit', 1);
  const offset = count(raw, 'offset', 0) ?? 0;

  const all = views(store);
  let rows = view === 'all' ? all : orderTickets(all);
  if (view === 'ready') rows = rows.filter((t) => t.ready);
  if (view === 'blocked') rows = rows.filter((t) => !t.ready);
  const inRepo = repo === undefined ? undefined : repoFilter(all, repo);
  rows = rows.filter(
    (t) =>
      (status === undefined || t.status === status) &&
      (priority === undefined || t.priority === priority) &&
      (type === undefined || t.type === type) &&
      (area === undefined || t.area === area) &&
      (inRepo === undefined || inRepo(t)),
  );
  return {
    total: rows.length,
    tickets: rows.slice(offset, limit === undefined ? undefined : offset + limit).map((t) => {
      const summary: Partial<TicketView> = { ...t };
      delete summary.body;
      return summary as TicketSummary;
    }),
  };
}

export interface TicketJob {
  id: string;
  title: string;
  stage: Job['stage'];
  status: Job['status'];
  prUrl: string | null;
  prState: Job['prState'];
  supersededBy: string | null;
  createdAt: string;
}

export function jobsOfTicket(store: Store, id: unknown): TicketJob[] {
  return ticketJobs(store.db, parseTicketId(id)).map((j) => ({
    id: j.id,
    title: j.title,
    stage: j.stage,
    status: j.status,
    prUrl: j.prUrl,
    prState: j.prState,
    supersededBy: j.supersededBy,
    createdAt: j.createdAt,
  }));
}

export interface TicketDetail {
  ticket: TicketView;
  /** Tickets that depend on this one. */
  dependents: number[];
  jobs: TicketJob[];
  /** Attached files, and the private directory they live in. */
  assets: string[];
  assetDir: string;
  /** Merge receipt of the ticket's newest completed job; null until a job completes. */
  receipt: { jobId: string; markdown: string } | null;
}

export function showTicket(store: Store, id: unknown): TicketDetail {
  const n = parseTicketId(id);
  const assetDir = ticketAssetDir(n, store.paths);
  const done = ticketJobs(store.db, n).findLast((j) => j.stage === 'completed');
  return {
    ticket: viewOf(store, n),
    dependents: dependentsOf(store.db, n),
    jobs: jobsOfTicket(store, n),
    assets: existsSync(assetDir) ? readdirSync(assetDir).sort() : [],
    assetDir,
    receipt: done ? { jobId: done.id, markdown: receiptMarkdown(buildReceipt(store, done)) } : null,
  };
}

export function ticketHistory(store: Store, id: unknown, raw: Raw = {}): TicketEvent[] {
  return listTicketEvents(store.db, parseTicketId(id), count(raw, 'limit', 1));
}

export function ticketAreas(store: Store): Area[] {
  return listAreas(store.db);
}

export function addTicketArea(store: Store, raw: Raw): Area[] {
  return addArea(store, {
    name: text(raw, 'name') ?? '',
    description: text(raw, 'description') ?? '',
  });
}

/** File a ticket for the repository at `raw.repo`, else the one containing `cwd`. */
export function addTicket(store: Store, raw: Raw, cwd?: string): TicketView {
  const title = text(raw, 'title');
  if (!title?.trim()) throw new ValidationError('A ticket needs a title.');
  const path = text(raw, 'repo') ?? cwd;
  if (path === undefined) {
    throw new ValidationError('A ticket belongs to a repository: pass repo, a path inside it.');
  }
  const created = createTicket(store, {
    ...fields(raw),
    title,
    ...ticketRepository(path),
    dependsOn: idList(raw, 'dependsOn'),
    related: idList(raw, 'related'),
    actor: text(raw, 'actor'),
  });
  return viewOf(store, created.id);
}

export const TICKET_ACTIONS = [
  'edit',
  'note',
  ...LIFECYCLE_ACTIONS,
  'move',
  'dep-add',
  'dep-remove',
  'related-add',
  'related-remove',
] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

/**
 * One mutation of one ticket. `raw.action` picks it; `raw.revision` guards against a concurrent
 * change; the rest depends on the action: field values for `edit` (`repo` re-associates the
 * ticket with the checkout at that path; `rank` a number or `none`), `text` for `note`, exactly
 * one of `up`, `down`, `top`, `before: <id>` for `move`, `of` for `duplicate`, `target` for
 * the link actions, and an optional `note` on a lifecycle action.
 */
export function ticketAction(store: Store, id: unknown, raw: Raw): TicketView {
  const n = parseTicketId(id);
  const action = text(raw, 'action') as TicketAction | undefined;
  if (action === undefined || !TICKET_ACTIONS.includes(action)) {
    throw new ValidationError(`action must be one of ${TICKET_ACTIONS.join(', ')}`);
  }
  const w = write(raw);
  const target = () => parseTicketId(raw['target'], 'target ticket');
  switch (action) {
    case 'edit': {
      const repo = text(raw, 'repo');
      editTicket(
        store,
        n,
        { ...fields(raw), rank: rank(raw), ...(repo ? ticketRepository(repo) : {}) },
        w,
      );
      break;
    }
    case 'move':
      moveTicket(store, n, moveTo(raw), w);
      break;
    case 'note':
      addTicketNote(store, n, text(raw, 'text') ?? '', w);
      break;
    case 'dep-add':
    case 'dep-remove':
      setTicketLink(store, n, target(), 'depends_on', action === 'dep-add', w);
      break;
    case 'related-add':
    case 'related-remove':
      setTicketLink(store, n, target(), 'related', action === 'related-add', w);
      break;
    default:
      ticketLifecycle(store, n, action satisfies LifecycleAction, {
        ...w,
        of: raw['of'] === undefined ? undefined : parseTicketId(raw['of'], 'duplicate-of ticket'),
        note: text(raw, 'note'),
      });
  }
  return viewOf(store, n);
}

/** Copy a file into the ticket's private asset directory and record it. Never moves the source. */
export function addTicketAsset(
  store: Store,
  id: unknown,
  file: string,
  raw: Raw = {},
): TicketDetail {
  const n = parseTicketId(id);
  getTicket(store.db, n);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new ValidationError(`${file} is not a file.`);
  }
  const name = basename(file).replace(/[^\w.-]+/g, '-');
  const dir = ticketAssetDir(n, store.paths);
  if (existsSync(join(dir, name))) {
    throw new ValidationError(`Ticket ${ticketKey(n)} already has an asset named ${name}.`);
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, join(dir, name));
  recordTicketEvent(store, n, { type: 'ticket.asset-added', payload: { name } }, write(raw));
  return showTicket(store, n);
}

/** Whether `path` is inside the ticket's repository (its checkout, a worktree, a clone of its remote). */
export function ticketIsAt(ticket: Pick<Ticket, 'repo' | 'repoPath'>, path: string): boolean {
  return existsSync(path) && findProjectRoot(path) !== undefined && inRepositoryAt(path)(ticket);
}

export interface TicketJobRequest {
  ticket: LinkedTicket;
  /** Path to resolve the job's repository from. */
  path: string;
  title: string;
  description: string;
}

/**
 * What a job for `ticketId` is created from. `target` is where the caller wants the job (an
 * explicit --repo, or the session's cwd): it must be the ticket's repository. Without one the
 * ticket's recorded checkout is used. The claim itself happens in `createJob`'s transaction.
 */
export function ticketJobRequest(
  store: Store,
  ticketId: unknown,
  target: string | undefined,
): TicketJobRequest {
  const ticket = getLinkedTicket(store.db, parseTicketId(ticketId));
  const key = ticketKey(ticket.id);
  const problem = repoProblemOf()(ticket);
  let path = ticket.repoPath;
  if (target !== undefined) {
    // The ticket decides the repository; a caller standing anywhere else is told where to go.
    if (!ticketIsAt(ticket, target)) {
      throw new ValidationError(
        `Ticket ${key} belongs to ${ticket.repo} (${ticket.repoPath}); ${target} is ` +
          `${findProjectRoot(target) === undefined ? 'not inside a Git repository' : 'another repository'}. ` +
          'Run from that repository or pass --repo <path> inside it. Nothing was created.',
      );
    }
    path = target;
  } else if (problem !== null) {
    throw new ValidationError(`Ticket ${key} cannot be started: ${problem}. Nothing was created.`);
  }
  return {
    ticket,
    path,
    title: `Ticket ${key}: ${ticket.title}`,
    description: `Ticket ${key} (${ticket.title}).${ticket.body ? `\n\n${ticket.body}` : ''}`,
  };
}
