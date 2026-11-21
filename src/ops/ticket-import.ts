/**
 * One-shot import of a Markdown todo register (core/todo-register.ts) into the ticket queue.
 * Reads and validates everything first, plans ids and job associations, then writes in one
 * transaction (storage/ticket-import.ts). The register's files are only read, never changed.
 *
 * Ids: when no register id is taken, every todo keeps its id. Otherwise all of them get new
 * consecutive ids after the highest ticket, in register order, and references in the frontmatter
 * are rewritten through that map (text inside bodies is left as written). Running it again for a
 * register that was imported in full changes nothing.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NotFoundError, ValidationError } from '../core/errors.ts';
import { canonicalPath, findProjectRoot, ticketAssetDir } from '../core/paths.ts';
import { DEFAULT_AREAS, type Priority, ticketKey, type TicketStatus } from '../core/tickets.ts';
import {
  parseAreas,
  parseTodo,
  type RegisterTodo,
  TODO_FILE,
  validateRegister,
} from '../core/todo-register.ts';
import { TERMINAL_STATUSES } from '../core/workflow.ts';
import type { Store } from '../storage/client.ts';
import {
  importedFingerprints,
  importedFrom,
  type ImportRow,
  importTickets,
  maxTicketId,
  takenTicketIds,
} from '../storage/ticket-import.ts';
import { listAreas } from '../storage/tickets.ts';
import { findJobs, jobRepository } from './repo.ts';

export interface ImportInput {
  /** The register directory; defaults to `todo` in the primary checkout of `cwd`'s repository. */
  dir?: string | undefined;
  /** A path inside the repository the tickets belong to; defaults to the one containing `dir`. */
  repo?: string | undefined;
  cwd: string;
  dryRun?: boolean | undefined;
  actor?: string | undefined;
}

export interface JobReference {
  job: string;
  /** Global ticket id. */
  ticket: number;
  why: string;
}

export interface ImportReport {
  source: string;
  repo: string;
  repoPath: string;
  dryRun: boolean;
  /** The register was imported before, in full; nothing was (or would be) changed. */
  alreadyImported: boolean;
  /** False when ids collided and every todo got a new one. */
  idsPreserved: boolean;
  /** Register id -> global ticket id, in register order. */
  idMap: Record<string, number>;
  counts: {
    tickets: number;
    byStatus: Partial<Record<TicketStatus, number>>;
    dependencies: number;
    related: number;
    duplicates: number;
  };
  /** One row per todo, in register order, with links already mapped to global ids. */
  tickets: {
    importId: number;
    id: number;
    title: string;
    status: TicketStatus;
    priority: Priority;
    dependsOn: number[];
    related: number[];
    duplicateOf: number | null;
  }[];
  areasAdded: string[];
  jobs: {
    /** Jobs whose title names exactly one todo of this register: associated. */
    linked: JobReference[];
    /** Jobs that might belong to a ticket but are not associated; decide by hand. */
    ambiguous: JobReference[];
    /** Job ids written in a ticket that match no job in this database. */
    unresolved: JobReference[];
  };
  assets: { ticket: number; file: string }[];
  warnings: string[];
  /** The number the next new ticket gets. */
  nextId: number;
}

/** Todo ids a job title names: `Todo 0074: ...`, `0044: ...`, `... (todo 8)`, `... (0052)`. */
export function todoIdsInTitle(title: string): number[] {
  const ids = new Set<number>();
  for (const m of title.matchAll(/\btodos?\s+#?(\d+(?:\s*,\s*\d+)*)/gi)) {
    for (const n of (m[1] ?? '').split(',')) ids.add(Number(n));
  }
  const lead = /^(\d{4})\b/.exec(title);
  if (lead) ids.add(Number(lead[1]));
  for (const m of title.matchAll(/\((\d{4})\)/g)) ids.add(Number(m[1]));
  return [...ids];
}

/**
 * Canonical hash of one register entry: every frontmatter value and the body, independent of the
 * file name, key spacing, and line endings. Stored on the ticket's `ticket.imported` event.
 */
export function fingerprint(todo: RegisterTodo): string {
  const canonical = JSON.stringify(
    Object.entries(todo)
      .filter(([key]) => key !== 'file')
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function importRegister(store: Store, input: ImportInput): ImportReport {
  const dryRun = input.dryRun ?? false;
  const dir =
    input.dir ??
    (() => {
      if (findProjectRoot(input.cwd) === undefined) {
        throw new ValidationError(
          `${input.cwd} is not inside a Git repository: pass --dir <register> and --repo <path>.`,
        );
      }
      return join(jobRepository(input.cwd).repo.root, 'todo');
    })();
  if (!existsSync(dir)) throw new NotFoundError(`No todo register at ${dir}.`);
  const files = readdirSync(dir)
    .filter((f) => TODO_FILE.test(f))
    .sort();
  if (files.length === 0) throw new NotFoundError(`No todo files (NNNN-*.md) in ${dir}.`);

  const repoFrom = input.repo ?? dir;
  if (findProjectRoot(repoFrom) === undefined) {
    throw new ValidationError(
      `${repoFrom} is not inside a Git repository: pass --repo <path> to the repository these tickets belong to.`,
    );
  }
  const { repo } = jobRepository(repoFrom);
  const source = canonicalPath(dir);

  // Everything is parsed and cross-checked before anything is planned or written.
  const todos = files.map((f) => parseTodo(readFileSync(join(dir, f), 'utf8'), f));
  const areasFile = join(dir, 'areas.md');
  const areas = existsSync(areasFile)
    ? parseAreas(readFileSync(areasFile, 'utf8'))
    : [...DEFAULT_AREAS];
  const warnings = validateRegister(todos, areas);

  const registerIds = todos.map((t) => t.id);
  const before = importedFrom(store.db, source);
  const alreadyImported = before.size > 0;
  const prints = new Map(todos.map((t) => [t.id, fingerprint(t)]));
  if (alreadyImported) {
    // A repeat is a no-op only for the register exactly as it was imported: same todos, and
    // each one's content (every frontmatter value and the body) unchanged.
    const was = importedFingerprints(store.db, source);
    const list = (ids: number[]) => ids.map(ticketKey).join(', ');
    const differences = [
      ['changed', registerIds.filter((id) => before.has(id) && was.get(id) !== prints.get(id))],
      ['added', registerIds.filter((id) => !before.has(id))],
      ['removed', [...before.keys()].filter((id) => !prints.has(id)).sort((a, b) => a - b)],
    ] as const;
    const found = differences.filter(([, ids]) => ids.length > 0);
    if (found.length > 0) {
      throw new ValidationError(
        `${source} was imported before (${String(before.size)} tickets) and has changed since: ` +
          `${found.map(([what, ids]) => `${what} ${list(ids)}`).join('; ')}. The database is the ` +
          'source of truth after an import: make the change with orch ticket, not in the register. ' +
          'Nothing was changed.',
      );
    }
  }

  const top = maxTicketId(store.db);
  const idsPreserved = alreadyImported
    ? registerIds.every((id) => before.get(id) === id)
    : takenTicketIds(store.db, registerIds).length === 0;
  const map = new Map<number, number>(
    registerIds.map((id, i) => [id, before.get(id) ?? (idsPreserved ? id : top + 1 + i)]),
  );
  const to = (id: number) => map.get(id) ?? id;
  if (!alreadyImported && !idsPreserved) {
    warnings.push(
      'Register ids collide with existing tickets: every todo gets a new id (see idMap). ' +
        'Ids written inside ticket bodies still use the old numbers.',
    );
  }

  const rows: ImportRow[] = todos.map((t) => ({
    id: to(t.id),
    importId: t.id,
    fingerprint: prints.get(t.id) ?? '',
    title: t.title,
    status: t.status,
    type: t.type,
    area: t.area,
    priority: t.priority,
    effort: t.effort,
    classified: t.classified,
    body: t.body,
    createdAt: t.created,
    updatedAt: t.updated,
    dependsOn: t.dependsOn.map(to),
    related: t.related.map(to),
    duplicateOf: t.duplicateOf === null ? null : to(t.duplicateOf),
  }));

  // Jobs: a title that names exactly one todo of this register identifies its ticket.
  const jobs = { linked: [], ambiguous: [], unresolved: [] } as ImportReport['jobs'];
  const repoJobs = findJobs(store, { repo: repo.root });
  const jobById = new Map(repoJobs.map((j) => [j.id, j]));
  const activeTaken = new Set<number>();
  for (const job of [...repoJobs].reverse()) {
    const named = todoIdsInTitle(job.title).filter((id) => map.has(id));
    if (named.length === 0) continue;
    const ticket = to(named[0] ?? 0);
    if (named.length > 1) {
      jobs.ambiguous.push({ job: job.id, ticket, why: `title names several todos: ${job.title}` });
    } else if (job.ticketId !== null) {
      if (job.ticketId !== ticket) {
        jobs.ambiguous.push({
          job: job.id,
          ticket,
          why: `already belongs to ticket ${ticketKey(job.ticketId)}`,
        });
      }
    } else if (!TERMINAL_STATUSES.includes(job.status) && activeTaken.has(ticket)) {
      jobs.ambiguous.push({
        job: job.id,
        ticket,
        why: 'a second unfinished job for the same ticket; a ticket has at most one',
      });
    } else {
      if (!TERMINAL_STATUSES.includes(job.status)) activeTaken.add(ticket);
      jobs.linked.push({ job: job.id, ticket, why: `title: ${job.title}` });
    }
  }
  // Job ids written in a body are reported, never associated: a note may name a job for any reason.
  const linkedPairs = new Set(jobs.linked.map((l) => `${l.job} ${String(l.ticket)}`));
  for (const row of rows) {
    for (const id of new Set(row.body.match(/\bjob-[0-9a-f]{8}\b/g) ?? [])) {
      if (linkedPairs.has(`${id} ${String(row.id)}`)) continue;
      const job = jobById.get(id);
      if (!job) {
        jobs.unresolved.push({
          job: id,
          ticket: row.id,
          why: 'mentioned in the ticket; no such job for this repository',
        });
      } else if (job.ticketId !== row.id) {
        jobs.ambiguous.push({
          job: id,
          ticket: row.id,
          why: 'mentioned in the ticket; its title does not name it',
        });
      }
    }
  }

  const assetDir = join(dir, 'assets');
  const assets = (existsSync(assetDir) ? readdirSync(assetDir).sort() : []).flatMap((file) => {
    const m = /^(\d{4})-/.exec(file);
    const ticket = m ? map.get(Number(m[1])) : undefined;
    if (ticket === undefined)
      warnings.push(`assets/${file} names no todo of this register; not copied`);
    return ticket === undefined ? [] : [{ ticket, file }];
  });

  const known = new Set(listAreas(store.db).map((a) => a.name));
  const newAreas = areas.filter((a) => !known.has(a.name));
  const byStatus: Partial<Record<TicketStatus, number>> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const report: ImportReport = {
    source,
    repo: repo.identity,
    repoPath: repo.root,
    dryRun,
    alreadyImported,
    idsPreserved,
    idMap: Object.fromEntries(registerIds.map((id) => [ticketKey(id), to(id)])),
    counts: {
      tickets: rows.length,
      byStatus,
      dependencies: rows.reduce((n, r) => n + r.dependsOn.length, 0),
      related: rows.reduce((n, r) => n + r.related.length, 0),
      duplicates: rows.filter((r) => r.duplicateOf !== null).length,
    },
    tickets: rows.map((r) => ({
      importId: r.importId,
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      dependsOn: r.dependsOn,
      related: r.related,
      duplicateOf: r.duplicateOf,
    })),
    areasAdded: alreadyImported ? [] : newAreas.map((a) => a.name),
    jobs: alreadyImported ? { linked: [], ambiguous: [], unresolved: [] } : jobs,
    assets: alreadyImported ? [] : assets,
    warnings,
    nextId: Math.max(top, ...rows.map((r) => r.id)) + 1,
  };
  if (dryRun || alreadyImported) return report;

  report.jobs.linked = importTickets(store, {
    source,
    repo: repo.identity,
    repoPath: repo.root,
    rows,
    areas: newAreas,
    jobLinks: jobs.linked.map(({ job, ticket }) => ({ job, ticket })),
    actor: input.actor,
  }).map((l) => jobs.linked.find((j) => j.job === l.job) ?? { ...l, why: '' });
  // After the commit: a failed copy is reported, and the original stays where it was.
  for (const a of assets) {
    try {
      const target = ticketAssetDir(a.ticket, store.paths);
      mkdirSync(target, { recursive: true });
      copyFileSync(join(assetDir, a.file), join(target, a.file));
    } catch (err) {
      report.warnings.push(
        `assets/${a.file} was not copied: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return report;
}
