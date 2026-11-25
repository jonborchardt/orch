/** `orch ticket ...` handlers: map flags to the shared ticket operations in ops/tickets.ts. */
import { readFileSync } from 'node:fs';

import { UsageError } from '../core/errors.ts';
import { EFFORTS, PRIORITIES, TICKET_STATUSES, TICKET_TYPES } from '../core/tickets.ts';
import {
  addTicket,
  addTicketArea,
  addTicketAsset,
  jobsOfTicket,
  listTickets,
  showTicket,
  TICKET_VIEWS,
  ticketAction,
  ticketAreas,
  ticketHistory,
  ticketIsAt,
  type TicketList,
} from '../ops/tickets.ts';
import type { Store } from '../storage/client.ts';
import { need } from './args.ts';

export interface TicketOptions {
  title?: string;
  repo?: string;
  type?: string;
  area?: string;
  priority?: string;
  effort?: string;
  classified?: string;
  'depends-on'?: string;
  related?: string;
  body?: string;
  'body-file'?: string;
  status?: string;
  limit?: string;
  offset?: string;
  revision?: string;
  of?: string;
  note?: string;
  description?: string;
  session?: string;
  by?: string;
  rank?: string;
  up?: boolean;
  down?: boolean;
  top?: boolean;
  before?: string;
  position?: string;
}

export const TICKET_HELP = `Usage: orch ticket <command> [options]

One global queue for every repository. A ticket belongs to a repository; ids, priorities, and
order are global. Ids are numbers (85, 0085, #85 all name the same ticket).

  add <title> [--repo <path>] [--type ${TICKET_TYPES.join('|')}] [--area <a>]
      [--priority ${PRIORITIES.join('|')}] [--effort ${EFFORTS.join('|')}] [--classified auto|user]
      [--depends-on <ids>] [--related <ids>] [--body <md> | --body-file <file|->]
                              File a ticket for the repository containing the cwd (or --repo)
  list [filters]              Every ticket, by id
  order [filters]             Proposed order of the open tickets: dependencies first, then
                              ranked tickets by rank (a dependency takes its dependents' rank),
                              then priority, effort, area, id
  ready [filters]             The open tickets nothing stands in the way of, in that order
  blocked [filters]           The open tickets that are not ready, each with its reasons
  next [filters]              The first ready ticket (JSON: {"ticket": null} when there is none)
      filters: [--repo <path|identity|name>] [--status <s>] [--priority <p>] [--area <a>]
               [--type <t>] [--limit <n>] [--offset <n>]
               status is one of ${TICKET_STATUSES.join(', ')}
  show <id>                   The ticket, its body, dependents, jobs, and assets
  history <id> [--limit <n>]  Its append-only history, oldest first
  jobs <id>                   Every job that worked on it
  edit <id> [--title <t>] [--type <t>] [--area <a>] [--priority <p>] [--effort <d>]
      [--classified auto|user] [--body <md> | --body-file <file|->] [--repo <path>]
      [--rank <n|none>]       --body-file - reads the Markdown body from stdin; --rank sets the
                              explicit place in the order (lowest first), none unranks
  move <id> --up|--down|--top|--before <other>|--position <n>
                              Move an open ticket in the order by ranking it (and the tickets
                              above it); --position puts it at place n (1 is first) and shifts
                              the tickets in between; refused past one of its dependencies
  note <id> <text>            Append a dated note to the history
  start <id> [--note <n>]     open -> in-progress, without a job (for a job, use
                              orch factory start --ticket <id> or orch factory dispatch --ticket <id>)
  done <id> [--note <n>]      Close as done (refused while a job is still working on it)
  drop <id> [--note <n>]      Close as dropped
  reopen <id> [--note <n>]    Back to open
  duplicate <id> --of <id> [--note <n>]
  dep add|remove <id> <depends-on-id>      <id> waits until <depends-on-id> is done
  related add|remove <id> <other-id>       informational; never affects readiness
  area list | area add <name> --description <d>
  asset add <id> <file>       Copy a screenshot or attachment into the ticket's private directory

Every writing command takes --revision <n> to refuse a concurrent change (exit 4), and records
--session ($ORCH_SESSION) as the actor. Add --json for machine output.
Views: ${TICKET_VIEWS.join(', ')}.
`;

/** `--body`, or the file (`-` for stdin) named by `--body-file`. */
function bodyOf(o: TicketOptions): string | undefined {
  if (o.body !== undefined && o['body-file'] !== undefined) {
    throw new UsageError('Pass --body or --body-file, not both.');
  }
  const file = o['body-file'];
  if (file === undefined) return o.body;
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8')
      .replace(/\r\n/g, '\n')
      .trimEnd();
  } catch (err) {
    throw new UsageError(`Cannot read --body-file ${file}: ${(err as Error).message}`);
  }
}

export function runTicket(
  store: Store,
  args: string[],
  o: TicketOptions,
  env = process.env,
): unknown {
  const [cmd, ...rest] = args;
  const actor = o.session ?? env['ORCH_SESSION'];
  const id = (at = 0) => need(rest[at], '<id>', TICKET_HELP);
  const filters: Record<string, unknown> = { ...o };
  const act = (ticket: string, action: string, extra: Record<string, unknown> = {}) =>
    ticketAction(store, ticket, { action, revision: o.revision, actor, ...extra });
  const fieldFlags = {
    title: o.title,
    type: o.type,
    area: o.area,
    priority: o.priority,
    effort: o.effort,
    classified: o.classified,
    body: bodyOf(o),
  };

  switch (cmd) {
    case 'add':
      return addTicket(
        store,
        {
          ...fieldFlags,
          title: rest.length ? rest.join(' ') : o.title,
          repo: o.repo,
          dependsOn: o['depends-on'],
          related: o.related,
          actor,
        },
        process.cwd(),
      );
    case 'list':
    case 'order':
    case 'ready':
    case 'blocked':
      return listTickets(store, { ...filters, view: cmd === 'list' ? 'all' : cmd });
    case 'next':
      return {
        ticket: listTickets(store, { ...filters, view: 'ready', limit: 1 }).tickets[0] ?? null,
      };
    case 'show': {
      // `here`: the cwd is inside the ticket's repository, so a job for it can start from here.
      const shown = showTicket(store, id());
      return { ...shown, here: ticketIsAt(shown.ticket, process.cwd()) };
    }
    case 'history':
      return ticketHistory(store, id(), { limit: o.limit });
    case 'jobs':
      return jobsOfTicket(store, id());
    case 'edit':
      return act(id(), 'edit', { ...fieldFlags, repo: o.repo, rank: o.rank });
    case 'move': {
      const given = [o.up, o.down, o.top, o.before, o.position].filter(
        (v) => v !== undefined && v !== false,
      );
      if (given.length !== 1) {
        throw new UsageError(
          'Usage: orch ticket move <id> --up|--down|--top|--before <other>|--position <n>',
        );
      }
      return act(id(), 'move', {
        up: o.up,
        down: o.down,
        top: o.top,
        before: o.before,
        position: o.position,
      });
    }
    case 'note':
      return act(id(), 'note', { text: rest.slice(1).join(' ') || o.note });
    case 'start':
    case 'done':
    case 'drop':
    case 'reopen':
      return act(id(), cmd, { note: o.note });
    case 'duplicate':
      return act(id(), 'duplicate', { of: need(o.of, '--of <id>'), note: o.note });
    case 'dep':
    case 'related': {
      const verb = rest[0];
      if (verb !== 'add' && verb !== 'remove') {
        throw new UsageError(`Usage: orch ticket ${cmd} add|remove <id> <other-id>`);
      }
      return act(id(1), `${cmd}-${verb}`, { target: need(rest[2], '<other-id>') });
    }
    case 'area':
      if (rest[0] === 'list' || rest[0] === undefined) return ticketAreas(store);
      if (rest[0] !== 'add')
        throw new UsageError('Usage: orch ticket area list | add <name> --description <d>');
      return addTicketArea(store, {
        name: need(rest[1], '<name>'),
        description: need(o.description, '--description'),
      });
    case 'asset':
      if (rest[0] !== 'add') throw new UsageError('Usage: orch ticket asset add <id> <file>');
      return addTicketAsset(store, id(1), need(rest[2], '<file>'), { revision: o.revision, actor });
    case undefined:
      throw new UsageError(TICKET_HELP);
    default:
      throw new UsageError(`Unknown ticket command: ${cmd}\n\n${TICKET_HELP}`);
  }
}

/** Text for the list commands: one line per ticket, reasons under a blocked one. */
export function formatTicketList(list: TicketList): string {
  if (list.tickets.length === 0) return '(none)';
  const rows = list.tickets.map((t) => [
    t.key,
    t.rank === null ? '-' : String(t.rank),
    t.priority,
    String(t.effort),
    t.status,
    t.type,
    t.area,
    t.repo.split('/').pop() ?? t.repo,
    t.title,
  ]);
  const table = [['ID', 'RANK', 'PRI', 'DAYS', 'STATUS', 'TYPE', 'AREA', 'REPO', 'TITLE'], ...rows];
  const widths = table[0]?.map((_, i) => Math.max(...table.map((r) => r[i]?.length ?? 0))) ?? [];
  const lines = table.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
  // lines[0] is the header, so line i belongs to ticket i - 1.
  const out = lines.flatMap((line, i) => {
    const reasons = list.tickets[i - 1]?.blockedBy ?? [];
    return reasons.length
      ? [line, `      blocked: ${reasons.map((b) => b.detail).join('; ')}`]
      : [line];
  });
  const shown = list.tickets.length;
  if (shown < list.total) out.push(`(${String(shown)} of ${String(list.total)})`);
  return out.join('\n');
}
