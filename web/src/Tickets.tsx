/**
 * The Tickets section: the global ticket queue with its filters and first ready ticket,
 * and (on `#/tickets/<id>`) one ticket. Readiness, blockers, and order are the server's; this
 * file only filters and shows them.
 */
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Area, BoardRow, TicketSummary, TicketView } from '../../src/server/types.ts';
import { usePolled } from './Runs.tsx';
import { Pick, Reasons, TicketDetail, TicketFields } from './TicketDetail.tsx';
import {
  createTicket,
  errorText,
  fetchAreas,
  fetchBoard,
  fetchTickets,
  ticketAction,
} from './api.ts';
import { STATE, repoLabels } from './format.ts';
import {
  EFFORTS,
  PRIORITIES,
  TYPES,
  jobsByTicket,
  ticketHref,
  ticketKey,
  ticketState,
} from './ticketState.ts';
import { weight } from './theme.ts';

/** `current` is what is left to do: the tickets in progress, then the open ones in queue order. */
const SHOWS = [
  'current',
  'ready',
  'blocked',
  'in-progress',
  'done',
  'dropped',
  'duplicate',
  'all',
] as const;
type Show = (typeof SHOWS)[number];

export interface TicketFilters {
  show: Show;
  repo: string;
  priority: string;
  area: string;
  type: string;
  text: string;
}
export const NO_FILTERS: TicketFilters = {
  show: 'current',
  repo: '',
  priority: '',
  area: '',
  type: '',
  text: '',
};

function shown(t: TicketSummary, show: Show): boolean {
  switch (show) {
    case 'all':
      return true;
    case 'current':
      return t.status === 'open' || t.status === 'in-progress';
    case 'ready':
      return t.ready;
    case 'blocked':
      return t.status === 'open' && !t.ready;
    default:
      return t.status === show;
  }
}

function matches(t: TicketSummary, f: TicketFilters): boolean {
  const q = f.text.trim().toLowerCase();
  return (
    (!f.repo || t.repo === f.repo) &&
    (!f.priority || t.priority === f.priority) &&
    (!f.area || t.area === f.area) &&
    (!f.type || t.type === f.type) &&
    (!q || `${ticketKey(t.id)} #${String(t.id)} ${t.title}`.toLowerCase().includes(q))
  );
}

/** The look of the native inputs in the ticket table. */
const NATIVE_SX = {
  font: 'inherit',
  color: 'inherit',
  bgcolor: 'transparent',
  border: 1,
  borderColor: 'divider',
  borderRadius: 1,
} as const;

/** The queue's first ready ticket, never promised as what the controller runs next. */
function ReadyLine({
  tickets,
  order,
}: {
  tickets: readonly TicketSummary[];
  order: readonly number[];
}) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const ready = order.flatMap((id) => (byId.get(id)?.ready ? [id] : []));
  const first = ready[0];
  return (
    <Typography
      variant="body2"
      color="text.secondary"
      sx={{ px: 1, pt: 1 }}
      data-testid="ready-line"
    >
      {first === undefined ? (
        'No ticket is ready.'
      ) : (
        <>
          Highest-priority ready ticket: <Link href={ticketHref(first)}>{ticketKey(first)}</Link>{' '}
          {byId.get(first)?.title} ({String(ready.length)} ready). The controller passes over a
          repository without the merge opt-in.
        </>
      )}
    </Typography>
  );
}

interface Repo {
  repo: string;
  repoPath: string;
}

// Enter moves the ticket to the typed place; leaving the field undoes the edit. One input per
// row, never keyed by position, so focus stays on it when a move reloads the list.
function PositionInput({
  label,
  at,
  max,
  onMove,
}: {
  label: string;
  at: number;
  max: number;
  onMove: (n: number) => void;
}) {
  const [value, setValue] = useState(String(at));
  useEffect(() => {
    setValue(String(at));
  }, [at]);
  return (
    <Box
      component="input"
      type="number"
      min={1}
      max={max}
      value={value}
      aria-label={label}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
        setValue(e.currentTarget.value);
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return;
        const n = Number(value);
        setValue(String(at));
        if (n > 0 && n !== at) onMove(n);
      }}
      onBlur={() => {
        setValue(String(at));
      }}
      sx={{ width: '4.5em', ...NATIVE_SX }}
    />
  );
}

/** File a ticket through POST /api/tickets, which validates everything. */
function CreateTicket({
  repos,
  areas,
  onClose,
  onCreated,
}: {
  /** Checkouts of existing tickets and jobs: creation needs a path, not an identity. */
  repos: readonly Repo[];
  areas: readonly Area[];
  onClose: () => void;
  onCreated: (t: TicketView) => void;
}) {
  // The server's own defaults, shown so nothing is chosen behind the user's back.
  const [f, setF] = useState({
    title: '',
    repo: repos[0]?.repoPath ?? '',
    type: 'feature',
    area: 'other',
    priority: 'P3',
    effort: '1',
    body: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => {
    setF((old) => ({ ...old, [k]: v }));
  };
  const submit = () => {
    setBusy(true);
    createTicket({ ...f, effort: Number(f.effort) })
      .then(onCreated, (err: unknown) => {
        setError(errorText(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="new-ticket-title">
      <DialogTitle id="new-ticket-title">New ticket</DialogTitle>
      <DialogContent>
        {repos.length === 0 ? (
          <Alert severity="info">
            No repository is known yet: the dashboard offers the checkouts of existing tickets and
            jobs. File the first ticket from inside the repository with <code>orch ticket add</code>
            .
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error && (
              <Alert severity="error" role="alert">
                {error}
              </Alert>
            )}
            <TicketFields
              create
              value={f}
              onChange={(k, v) => {
                set(k)(v);
              }}
              areas={areas.length ? areas.map((a) => a.name) : ['other']}
              efforts={EFFORTS.map(String)}
              lead={
                <Pick
                  label="Repository"
                  value={f.repo}
                  onChange={set('repo')}
                  options={repos.map((r) => ({
                    value: r.repoPath,
                    label: `${r.repo} (${r.repoPath})`,
                  }))}
                  width={260}
                />
              }
            />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        {repos.length > 0 && (
          <Button variant="contained" onClick={submit} disabled={busy || !f.title.trim()}>
            Create ticket
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

interface Data {
  tickets: TicketSummary[];
  /** Ids of the open tickets in the server's proposed order. */
  order: number[];
  rows: BoardRow[];
}

export function TicketsPage({
  id,
  refreshMs = 4000,
  filters,
  onFilters,
}: {
  /** The ticket of `#/tickets/<id>`; null for the list. */
  id: number | null;
  refreshMs?: number;
  /** Kept by the caller, so they survive a visit to a ticket or a job. */
  filters: TicketFilters;
  onFilters: (f: TicketFilters) => void;
}) {
  const [areas, setAreas] = useState<Area[]>([]);
  // A refused write; kept until dismissed, where a poll's error clears with the next good poll.
  const [refused, setRefused] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Three requests for the whole view, whatever the number of tickets: never one per row. The
  // factory's status is the shared header's, polled by App.
  const {
    data,
    error: polled,
    reload,
  } = usePolled(
    useCallback(
      () =>
        Promise.all([fetchTickets('all'), fetchTickets('order'), fetchBoard()]).then(
          ([all, order, rows]): Data => ({
            tickets: all.tickets,
            order: order.tickets.map((t) => t.id),
            rows,
          }),
        ),
      [],
    ),
    refreshMs,
  );
  // Dismissing a poll's error hides that one error; the next failed poll shows again.
  const [dismissed, setDismissed] = useState<unknown>(null);
  const error = polled === null || polled === dismissed ? null : errorText(polled);
  useEffect(() => {
    fetchAreas().then(setAreas, () => undefined);
  }, []);

  const tickets = useMemo(() => data?.tickets ?? [], [data]);
  const rank = useMemo(() => new Map((data?.order ?? []).map((t, i) => [t, i])), [data]);
  const jobs = useMemo(() => jobsByTicket(tickets, data?.rows ?? []), [tickets, data]);
  const visible = useMemo(() => {
    const rows = tickets.filter((t) => shown(t, filters.show) && matches(t, filters));
    // Tickets in progress first, then the open ones as the server orders them; the rest by id.
    return rows.sort((a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1) || a.id - b.id);
  }, [tickets, filters, rank]);
  const repos = useMemo(() => {
    const seen = new Map<string, Repo>();
    for (const r of [...tickets, ...(data?.rows ?? [])]) {
      if (!seen.has(r.repoPath)) seen.set(r.repoPath, { repo: r.repo, repoPath: r.repoPath });
    }
    return [...seen.values()];
  }, [tickets, data]);

  if (id !== null) {
    return (
      <TicketDetail
        key={id}
        id={id}
        tickets={tickets}
        jobs={jobs}
        areas={areas}
        refreshMs={refreshMs}
        onChanged={reload}
      />
    );
  }
  if (!data) {
    return error ? (
      <Alert severity="error" role="alert" sx={{ m: 1 }}>
        {error}
      </Alert>
    ) : (
      <Box sx={{ p: 3 }}>
        <LinearProgress aria-label="Loading tickets" />
      </Box>
    );
  }

  const set = (k: keyof TicketFilters) => (v: string) => {
    onFilters({ ...filters, [k]: v });
  };
  const labels = repoLabels(tickets.map((t) => t.repo));
  const repoIds = [...new Set(tickets.map((t) => t.repo))].sort();
  /** One ticket write; a refusal is kept until dismissed, and the queue is re-read either way. */
  const send = (t: TicketSummary, body: { action: string } & Record<string, unknown>) => {
    setRefused(null);
    ticketAction(t.id, { ...body, revision: t.revision })
      .catch((err: unknown) => {
        setRefused(`Ticket ${ticketKey(t.id)}: ${errorText(err)}`);
      })
      // The order is the server's to give.
      .finally(() => void reload());
  };
  const reprioritize = (t: TicketSummary, priority: string) => {
    send(t, { action: 'edit', priority });
  };
  // Up, Down, and a typed position move within the global order, not the filtered rows (as
  // `orch ticket move`); the server places the ticket, this only sends the number typed.
  const move = (t: TicketSummary, to: 'up' | 'down' | 'top' | { position: number }) => {
    send(t, { action: 'move', ...(typeof to === 'string' ? { [to]: true } : to) });
  };

  return (
    <>
      <ReadyLine tickets={tickets} order={data.order} />
      {(refused ?? error) && (
        <Alert
          severity="error"
          role="alert"
          sx={{ m: 1 }}
          onClose={() => {
            setRefused(null);
            setDismissed(polled);
          }}
        >
          {refused ?? error}
        </Alert>
      )}
      <Box
        role="search"
        aria-label="Ticket filters"
        sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 2, px: 1, py: 1.5 }}
      >
        <TextField
          type="search"
          label="Search"
          placeholder="id or title…"
          value={filters.text}
          onChange={(e) => {
            set('text')(e.target.value);
          }}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ minWidth: 180 }}
        />
        <Pick
          label="Show"
          value={filters.show}
          onChange={set('show')}
          options={SHOWS.map((s) => ({
            value: s,
            label: `${s} (${String(tickets.filter((t) => shown(t, s)).length)})`,
          }))}
          width={150}
        />
        <Pick
          label="Repository"
          value={filters.repo}
          onChange={set('repo')}
          options={repoIds}
          all="All repositories"
          width={160}
        />
        <Pick
          label="Priority"
          value={filters.priority}
          onChange={set('priority')}
          options={PRIORITIES}
          all="Any"
          width={90}
        />
        <Pick
          label="Area"
          value={filters.area}
          onChange={set('area')}
          options={[...new Set([...areas.map((a) => a.name), ...tickets.map((t) => t.area)])]}
          all="Any"
        />
        <Pick label="Type" value={filters.type} onChange={set('type')} options={TYPES} all="Any" />
        <Button
          variant="outlined"
          sx={{ ml: 'auto' }}
          onClick={() => {
            setCreating(true);
          }}
        >
          New ticket
        </Button>
      </Box>
      {tickets.length === 0 ? (
        <Typography sx={{ p: 3 }} color="text.secondary" role="status">
          No tickets yet. File one with New ticket, or from any repository with{' '}
          <code>orch ticket add</code>.
        </Typography>
      ) : visible.length === 0 ? (
        <Typography sx={{ p: 3 }} color="text.secondary" role="status">
          No ticket matches these filters ({String(tickets.length)} in all).
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small" aria-label="Tickets">
            <TableHead>
              <TableRow>
                <TableCell align="right">
                  <Tooltip title="Position among the open tickets in the server's proposed order: dependencies first, then ranked tickets by rank (Up, Down, Top, or a typed position and Enter set it), then priority, effort, area, id. Blocked tickets keep their place.">
                    <span>Queue</span>
                  </Tooltip>
                </TableCell>
                <TableCell>ID</TableCell>
                <TableCell>Title</TableCell>
                <TableCell>Repository</TableCell>
                <TableCell>Priority</TableCell>
                <TableCell>Effort</TableCell>
                <TableCell>State</TableCell>
                <TableCell>Area / Type</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Job</TableCell>
                <TableCell>Blocked by</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((t) => {
                const job = jobs.get(t.id);
                const state = ticketState(t, job);
                const key = ticketKey(t.id);
                const at = rank.get(t.id);
                return (
                  <TableRow key={t.id} hover data-ticket-id={t.id}>
                    <TableCell align="right" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
                      {at === undefined ? (
                        ''
                      ) : t.status === 'open' ? (
                        <PositionInput
                          label={`Position of ${key}`}
                          at={at + 1}
                          max={rank.size}
                          onMove={(n) => {
                            move(t, { position: n });
                          }}
                        />
                      ) : (
                        String(at + 1)
                      )}
                      {t.status === 'open' &&
                        (['up', 'down', 'top'] as const).map((to) => (
                          <Button
                            key={to}
                            size="small"
                            aria-label={`Move ${key} ${to === 'top' ? 'to the top' : to}`}
                            onClick={() => {
                              move(t, to);
                            }}
                            sx={{ minWidth: 0, px: 0.5, ml: 0.5 }}
                          >
                            {to === 'up' ? 'Up' : to === 'down' ? 'Down' : 'Top'}
                          </Button>
                        ))}
                    </TableCell>
                    <TableCell>{key}</TableCell>
                    <TableCell sx={{ minWidth: 200, overflowWrap: 'anywhere' }}>
                      <Link
                        href={ticketHref(t.id)}
                        underline="hover"
                        sx={{ fontWeight: weight.semibold }}
                      >
                        {t.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Tooltip title={`${t.repo} at ${t.repoPath}`}>
                        <span>{labels.get(t.repo) ?? t.repo.split('/').at(-1)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Box
                        component="select"
                        aria-label={`Priority of ${key}`}
                        value={t.priority}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                          reprioritize(t, e.target.value);
                        }}
                        sx={NATIVE_SX}
                      >
                        {PRIORITIES.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </Box>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{String(t.effort)} d</TableCell>
                    <TableCell>
                      <Chip
                        label={state.label}
                        color={state.color}
                        variant={state.variant}
                        title={state.describe}
                        data-ticket-state={state.label}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {t.area} / {t.type}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <time dateTime={t.createdAt} title={t.createdAt}>
                        {new Date(t.createdAt).toLocaleString()}
                      </time>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {job && (
                        <>
                          <Link href={`#/jobs/${job.id}`}>{job.id}</Link>{' '}
                          <Typography component="span" variant="body2" color="text.secondary">
                            {job.id === t.activeJob
                              ? job.stage
                              : (job.outcome?.label ?? STATE[job.liveness].label)}
                          </Typography>
                        </>
                      )}
                    </TableCell>
                    <TableCell sx={{ minWidth: 160, overflowWrap: 'anywhere' }}>
                      <Reasons reasons={t.blockedBy} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {creating && (
        <CreateTicket
          repos={repos}
          areas={areas}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(t) => {
            setCreating(false);
            void reload();
            window.location.hash = ticketHref(t.id);
          }}
        />
      )}
    </>
  );
}
