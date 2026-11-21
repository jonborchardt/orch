/**
 * How a ticket is shown. Everything here is presentation of what the server already decided:
 * `status`, `ready`, `blockedBy`, and `activeJob` come from /api/tickets, the job's liveness and
 * PR state from /api/jobs. No readiness, ordering, or lifecycle rule is repeated.
 */
import type {
  BoardRow,
  Priority,
  TicketStatus,
  TicketSummary,
  TicketType,
} from '../../src/server/types.ts';
import { type ChipColor, STATE } from './format.ts';

const keys = <K extends string>(o: Record<K, 0>) => Object.keys(o) as K[];
// Typed by the server's unions: a value added or removed there fails the typecheck here.
export const PRIORITIES = keys<Priority>({ P1: 0, P2: 0, P3: 0, P4: 0 });
export const TYPES = keys<TicketType>({ bug: 0, feature: 0, chore: 0, question: 0 });
export const STATUSES = keys<TicketStatus>({
  open: 0,
  'in-progress': 0,
  done: 0,
  dropped: 0,
  duplicate: 0,
});
/** Days. The server validates; this is only what the select offers (core/tickets.ts EFFORTS). */
export const EFFORTS = [0.25, 0.5, 1, 2, 3, 5];

/** `85` -> `0085`, the form shown to people. */
export const ticketKey = (id: number) => String(id).padStart(4, '0');
export const ticketHref = (id: number) => `#/tickets/${String(id)}`;

/** The job to show for each ticket: its unfinished job, else the one updated last. */
export function jobsByTicket(
  tickets: readonly Pick<TicketSummary, 'id' | 'activeJob'>[],
  rows: readonly BoardRow[],
): Map<number, BoardRow> {
  const active = new Map(tickets.map((t) => [t.id, t.activeJob]));
  const out = new Map<number, BoardRow>();
  for (const r of rows) {
    if (r.ticketId === null) continue;
    const have = out.get(r.ticketId);
    if (have?.id === active.get(r.ticketId)) continue;
    if (!have || r.id === active.get(r.ticketId) || r.updatedAt > have.updatedAt) {
      out.set(r.ticketId, r);
    }
  }
  return out;
}

export interface TicketState {
  label: string;
  color: ChipColor;
  variant: 'filled' | 'outlined';
  /** Tooltip: what the label means for this ticket. */
  describe: string;
}

/** The ticket's display state; `job` is its entry in `jobsByTicket`. */
export function ticketState(
  t: Pick<TicketSummary, 'status' | 'ready' | 'blockedBy' | 'activeJob' | 'duplicateOf'>,
  job: BoardRow | undefined,
): TicketState {
  const s = (
    label: string,
    color: ChipColor,
    variant: TicketState['variant'],
    describe: string,
  ): TicketState => ({ label, color, variant, describe });
  switch (t.status) {
    case 'done':
      return s('done', 'success', 'filled', 'Closed as done.');
    case 'dropped':
      return s('dropped', 'default', 'filled', 'Dropped: it will not be done.');
    case 'duplicate':
      return s(
        'duplicate',
        'default',
        'filled',
        t.duplicateOf === null ? 'A duplicate.' : `A duplicate of ${ticketKey(t.duplicateOf)}.`,
      );
    case 'open':
      return t.ready
        ? s('ready', 'success', 'outlined', 'Open, and nothing stands in the way.')
        : s('blocked', 'warning', 'outlined', t.blockedBy.map((b) => b.detail).join('; '));
    case 'in-progress':
  }
  if (t.activeJob !== null) {
    if (job?.id !== t.activeJob) {
      return s('in progress', 'primary', 'outlined', `Job ${t.activeJob} is working on it.`);
    }
    if (job.stage === 'ci' && ['running', 'stale', 'idle'].includes(job.liveness)) {
      return s('awaiting CI', 'info', 'outlined', `Job ${job.id} waits for the CI verdict.`);
    }
    const st = STATE[job.liveness];
    return s(st.label, st.color, st.variant, `Job ${job.id}: ${st.describe}`);
  }
  // In progress with no unfinished job: say what the last job left, never "running".
  if (job?.pr.state === 'merged') {
    return s(
      'merged, not closed',
      'warning',
      'outlined',
      `The PR of job ${job.id} was merged, but that did not close the ticket (unchecked checklist ` +
        'items or an unverified merge; see History). Close it with Done once the work is finished.',
    );
  }
  if (job?.liveness === 'completed') {
    return s(
      'awaiting integration',
      'info',
      'outlined',
      `Job ${job.id} finished; its PR is not merged yet.`,
    );
  }
  return s(
    'in progress',
    'default',
    'outlined',
    'Marked in progress, and no job is working on it.',
  );
}
