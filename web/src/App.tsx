import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  LinearProgress,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type { BoardRow } from '../../src/server/types.ts';
import { AgentsPage } from './Agents.tsx';
import { FactoryStatus } from './FactoryStatus.tsx';
import { JobBoard } from './JobBoard.tsx';
import { type DetailActivity, JobDetail } from './JobDetail.tsx';
import { RunsPage, usePolled } from './Runs.tsx';
import { Pick } from './TicketDetail.tsx';
import { NO_FILTERS, type TicketFilters, TicketsPage } from './Tickets.tsx';
import { UsagePage } from './Usage.tsx';
import { failureText, fetchBoard, fetchRepos, fetchRunner } from './api.ts';
import { statusColor, weight } from './theme.ts';

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash);
    };
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('hashchange', on);
    };
  }, []);
  return hash;
}

/** The top-level sections. A new one is an entry here and a branch where `main` is rendered. */
const SECTIONS = [
  { label: 'Jobs', href: '#/' },
  { label: 'Tickets', href: '#/tickets' },
  { label: 'Runs', href: '#/runs' },
  { label: 'Agents', href: '#/agents' },
  { label: 'Usage', href: '#/usage' },
] as const;

const STATUS_FILTERS = [
  'current',
  'active',
  'needs human',
  'running',
  'stale',
  'failed',
  'idle',
  'finished',
  'cancelled',
  'archived',
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function matches(row: BoardRow, f: StatusFilter): boolean {
  // Archived jobs appear only under `archived`; every other view hides them.
  if (f === 'archived') return row.archivedAt !== null;
  if (row.archivedAt !== null) return false;
  switch (f) {
    case 'current':
      return true;
    case 'active':
      return !['blocked', 'completed', 'cancelled'].includes(row.liveness);
    case 'needs human':
      return row.liveness === 'blocked';
    case 'running':
    case 'stale':
    case 'idle':
      return row.liveness === f;
    case 'failed':
      return row.liveness === 'failed' || row.liveness === 'interrupted';
    case 'finished':
      return row.liveness === 'completed' || row.liveness === 'cancelled';
    case 'cancelled':
      return row.liveness === 'cancelled';
  }
}

/** App-bar summary chips; each is a shortcut for its Show option and shares its count. */
const CHIPS = [
  { filter: 'running', label: 'running', color: statusColor.running },
  { filter: 'stale', label: 'stale', color: 'warning' },
  { filter: 'needs human', label: 'need human', color: statusColor.needsHuman },
  { filter: 'failed', label: 'failed', color: statusColor.failed },
  { filter: 'idle', label: 'idle', color: 'default' },
] as const;

/** Free-text filter: any of title, id, repo, stage, liveness, session, or branch contains it. */
function matchesText(row: BoardRow, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  return [row.title, row.id, row.repo, row.stage, row.liveness, row.owner?.session, row.branch]
    .filter((x): x is string => typeof x === 'string')
    .some((x) => x.toLowerCase().includes(q));
}

export function App({ refreshMs = 4000 }: { refreshMs?: number }) {
  const hash = useHashRoute();
  const [repo, setRepo] = useState<string>('');
  const [status, setStatus] = useState<StatusFilter>('current');
  const [text, setText] = useState('');
  const [detailActivity, setDetailActivity] = useState<DetailActivity>('loading');
  const [ticketFilters, setTicketFilters] = useState<TicketFilters>(NO_FILTERS);
  const ticketMatch = /^#\/tickets(?:\/(\d{1,9}))?\/?$/.exec(hash);
  const runsMatch = /^#\/runs\/?$/.test(hash);
  const agentsMatch = /^#\/agents\/?$/.test(hash);
  const usageMatch = /^#\/usage\/?$/.test(hash);
  const section = ticketMatch
    ? 'Tickets'
    : runsMatch
      ? 'Runs'
      : agentsMatch
        ? 'Agents'
        : usageMatch
          ? 'Usage'
          : 'Jobs';
  // Tickets, Runs, and Agents poll what they show and Usage loads on demand; the board, its
  // alert, and filters rest.
  const other = section !== 'Jobs';

  // The other sections poll what they show themselves; the job board rests meanwhile.
  const fetcher = useMemo(
    () =>
      other
        ? null
        : () =>
            Promise.all([fetchBoard(repo || undefined), fetchRepos()]).then(([rows, repos]) => ({
              rows,
              repos,
              now: Date.now(),
            })),
    [other, repo],
  );
  const board = usePolled(fetcher, refreshMs);
  const rows = board.data?.rows ?? null;
  const repos = board.data?.repos ?? [];
  const now = board.data?.now ?? 0;
  const error = board.error === null ? null : failureText(board.error);

  // The shared header's one runner poll, on every section: the Factory status box and whether
  // the installed build lags its checkout. A failed request shows no build warning: that is
  // advice, never an error.
  const runner = usePolled(fetchRunner, refreshMs);
  const build = runner.data?.build ?? null;

  // `?choose=<n>` (the mail's and terminal's per-choice link) only opens that choice's confirm.
  const jobMatch = /^#\/jobs\/(job-[0-9a-f]{8})(?:\?choose=(\d{1,2}))?$/.exec(hash);
  const visible = useMemo(
    () => (rows ?? []).filter((r) => matches(r, status) && matchesText(r, text)),
    [rows, status, text],
  );
  // Counts come from the selected repository's rows, before the text filter; none until the
  // first response, so the first load never reads as real zeros.
  const counts = useMemo(
    () =>
      rows &&
      (Object.fromEntries(
        STATUS_FILTERS.map((f) => [f, rows.filter((r) => matches(r, f)).length]),
      ) as Record<StatusFilter, number>),
    [rows],
  );
  // A background poll after the first load; never shown alongside a first-load bar.
  const boardPolling = board.loading && rows !== null;
  const refreshing = other
    ? false
    : jobMatch
      ? detailActivity === 'refreshing' || (detailActivity === 'idle' && boardPolling)
      : boardPolling;

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar
        position="sticky"
        color="default"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        {/* Vertical padding and row gap leave room for the shrunk outlined labels, which sit
            above their field; without it they clip at the app bar's top edge or a wrapped row. */}
        <Toolbar variant="dense" sx={{ columnGap: 1.5, rowGap: 2, py: 1.5, flexWrap: 'wrap' }}>
          <Typography
            variant="subtitle1"
            component="a"
            href="#/"
            sx={{ fontWeight: weight.bold, color: 'inherit', textDecoration: 'none' }}
          >
            orch factory
          </Typography>
          <Box component="nav" aria-label="Sections" sx={{ display: 'flex', gap: 0.5 }}>
            {SECTIONS.map((s) => (
              <Button
                key={s.label}
                href={s.href}
                variant={s.label === section ? 'outlined' : 'text'}
                color="inherit"
                aria-current={s.label === section ? 'page' : undefined}
              >
                {s.label}
              </Button>
            ))}
          </Box>
          {/* Job counts and filters belong to the Jobs section only. */}
          {!other && (
            <Stack direction="row" spacing={0.5} aria-label="Summary">
              {CHIPS.map((c) => {
                const pressed = status === c.filter;
                return (
                  <Chip
                    key={c.filter}
                    label={counts ? `${String(counts[c.filter])} ${c.label}` : c.label}
                    color={c.color}
                    variant={counts?.[c.filter] ? 'filled' : 'outlined'}
                    aria-pressed={pressed}
                    onClick={() => {
                      setStatus(pressed ? 'current' : c.filter);
                    }}
                    // A full ring in the text colour reads on filled and outlined chips, light or dark.
                    sx={
                      pressed
                        ? { outline: '2px solid', outlineColor: 'text.primary', outlineOffset: 2 }
                        : undefined
                    }
                  />
                );
              })}
            </Stack>
          )}
          {/* Board-only controls, wrapping as one group; detail routes have nothing to filter. */}
          {!jobMatch && !other && (
            <Box sx={{ ml: 'auto', display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 2 }}>
              <TextField
                size="small"
                type="search"
                label="Filter"
                placeholder="title, id, stage, branch…"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                }}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ minWidth: 200 }}
              />
              <Pick
                size="small"
                label="Repository"
                value={repo}
                onChange={setRepo}
                options={repos}
                all="All repositories"
                width={180}
              />
              <Pick
                size="small"
                label="Show"
                value={status}
                onChange={(v) => {
                  setStatus(v as StatusFilter);
                }}
                options={STATUS_FILTERS.map((s) => ({
                  value: s,
                  label: counts ? `${s} (${String(counts[s])})` : s,
                }))}
                width={140}
              />
            </Box>
          )}
        </Toolbar>
        {/* Fixed-height slot so the page never shifts when a poll starts or ends. */}
        <Box sx={{ height: 4 }}>
          {refreshing && <LinearProgress aria-label="Refreshing" sx={{ height: 4 }} />}
        </Box>
      </AppBar>
      <FactoryStatus
        runner={runner.data}
        error={runner.error}
        updatedAt={runner.updatedAt}
        refreshMs={refreshMs}
      />
      {build?.stale && (
        <Alert severity="warning" sx={{ m: 1 }}>
          {build.message}
        </Alert>
      )}
      {error && !other && (
        <Alert severity="error" sx={{ m: 1 }} role="alert">
          {error}
        </Alert>
      )}
      <Box component="main" sx={{ flex: 1 }}>
        {ticketMatch ? (
          <TicketsPage
            id={ticketMatch[1] === undefined ? null : Number(ticketMatch[1])}
            refreshMs={refreshMs}
            filters={ticketFilters}
            onFilters={setTicketFilters}
          />
        ) : runsMatch ? (
          <RunsPage refreshMs={refreshMs} />
        ) : agentsMatch ? (
          <AgentsPage refreshMs={refreshMs} />
        ) : usageMatch ? (
          <UsagePage />
        ) : jobMatch ? (
          <JobDetail
            id={jobMatch[1] ?? ''}
            choose={jobMatch[2] === undefined ? null : Number(jobMatch[2])}
            refreshMs={refreshMs}
            onActivity={setDetailActivity}
          />
        ) : rows === null ? (
          // A failed first load shows only the error alert above, not a bar that never ends.
          !error && (
            <Box sx={{ p: 3 }}>
              <LinearProgress aria-label="Loading jobs" />
            </Box>
          )
        ) : (
          <JobBoard
            rows={visible}
            total={rows.length}
            now={now}
            onChanged={() => void board.reload()}
          />
        )}
      </Box>
      <Box component="footer" sx={{ p: 1, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">
          Read from the shared orch database every {String(refreshMs / 1000)}s. &quot;running&quot;
          means a session renewed its lease recently, not that a process is alive right now.
        </Typography>
      </Box>
    </Box>
  );
}
