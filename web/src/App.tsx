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
import { useEffect, useMemo, useRef, useState } from 'react';

import type { BoardRow } from '../../src/server/types.ts';
import { AgentsPage } from './Agents.tsx';
import { FactoryStatus } from './FactoryStatus.tsx';
import { Help } from './Help.tsx';
import { JobBoard, parseSort, type Sort } from './JobBoard.tsx';
import { type DetailActivity, JobDetail } from './JobDetail.tsx';
import { RunsPage, usePolled } from './Runs.tsx';
import { Pick } from './TicketDetail.tsx';
import { NO_FILTERS, type TicketFilters, TicketsPage } from './Tickets.tsx';
import { UsagePage } from './Usage.tsx';
import { failureText, fetchBoard, fetchRepos, fetchRunner } from './api.ts';
import { tabOf } from './tabs.ts';
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

const TICKETS_ROUTE = /^#\/tickets(?:\/(\d{1,9}))?\/?$/;
const RUNS_ROUTE = /^#\/runs\/?$/;
const AGENTS_ROUTE = /^#\/agents\/?$/;
const USAGE_ROUTE = /^#\/usage\/?$/;
// `?choose=<n>` (the mail's and terminal's per-choice link) only opens that choice's confirm.
const JOB_ROUTE =
  /^#\/jobs\/(job-[0-9a-f]{8})(?:\/([^/?]*)(?:\/([^/?]*)(?:\/([^/?]*))?)?)?(?:\?choose=(\d{1,2}))?$/;

/** Every hash no other section claims is the board. */
function isBoard(hash: string): boolean {
  return ![TICKETS_ROUTE, RUNS_ROUTE, AGENTS_ROUTE, USAGE_ROUTE, JOB_ROUTE].some((r) =>
    r.test(hash),
  );
}

/** A URL part decoded; null for a malformed escape, which would otherwise throw in render. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** `#/jobs/<id>[/<tab>[/<round>[/<reviewer>]]][?choose=<n>]`; an unknown part reads as absent. */
function parseJobRoute(hash: string) {
  const m = JOB_ROUTE.exec(hash);
  if (!m) return null;
  const tab = tabOf(m[2]);
  const round = tab === 'Reviews' && /^\d{1,9}$/.test(m[3] ?? '') ? Number(m[3]) : null;
  const reviewer = round !== null && m[4] ? safeDecode(m[4]) : null;
  return {
    id: m[1] ?? '',
    tab,
    round,
    reviewer,
    choose: m[5] === undefined ? null : Number(m[5]),
  };
}

/** The board's settings: App session state, mirrored in `#/?show=&repo=&q=&sort=` (ticket 0007). */
interface BoardSettings {
  show: StatusFilter;
  repo: string;
  q: string;
  sort: Sort;
}
const DEFAULT_BOARD: BoardSettings = { show: 'current', repo: '', q: '', sort: null };
const BOARD_KEYS = ['show', 'repo', 'q', 'sort'];

/** The board parameters of a board hash, or null when it carries none (a bare `#/`). */
function boardParams(hash: string): URLSearchParams | null {
  const p = new URLSearchParams(/^#\/?\?(.*)$/.exec(hash)?.[1] ?? '');
  return BOARD_KEYS.some((k) => p.has(k)) ? p : null;
}

/** Absent or unknown values take their defaults. */
function parseBoard(p: URLSearchParams): BoardSettings {
  const show = (p.get('show') ?? '').replace(/-/g, ' ');
  return {
    show: STATUS_FILTERS.find((f) => f === show) ?? 'current',
    repo: p.get('repo') ?? '',
    q: p.get('q') ?? '',
    sort: parseSort(p.get('sort')),
  };
}

/** The board URL for these settings, defaults omitted: exactly `#/` when all are defaults. */
function boardHash(b: BoardSettings): string {
  const p = new URLSearchParams();
  if (b.show !== 'current') p.set('show', b.show.replace(/ /g, '-'));
  if (b.repo) p.set('repo', b.repo);
  if (b.q) p.set('q', b.q);
  if (b.sort) p.set('sort', `${b.sort.id}:${b.sort.dir}`);
  const query = p.toString();
  return query ? `#/?${query}` : '#/';
}

/** The Filter's URL write waits this long after the last keystroke. */
const FILTER_WRITE_MS = 400;

/**
 * The board settings and their URL (ticket 0007). A fresh load reads the URL; a `hashchange` to
 * a board URL with parameters overwrites the settings, and to a bare `#/` keeps them and replaces
 * the URL with them. The board's own changes replace the URL (no history entry, no hashchange),
 * only while the route is the board.
 */
function useBoardSettings() {
  const [settings, setSettings] = useState<BoardSettings>(() => {
    const p = boardParams(window.location.hash);
    return p && isBoard(window.location.hash) ? parseBoard(p) : DEFAULT_BOARD;
  });
  const current = useRef(settings);
  const pending = useRef<number | undefined>(undefined);

  const cancel = () => {
    window.clearTimeout(pending.current);
    pending.current = undefined;
  };
  const write = () => {
    cancel();
    if (isBoard(window.location.hash)) {
      window.history.replaceState(window.history.state, '', boardHash(current.current));
    }
  };
  useEffect(() => {
    const on = () => {
      cancel(); // A pending Filter write never rewrites the new route's URL.
      const hash = window.location.hash;
      if (!isBoard(hash)) return;
      const p = boardParams(hash);
      if (p) {
        current.current = parseBoard(p);
        setSettings(current.current);
      } else if (boardHash(current.current) !== '#/') {
        window.history.replaceState(window.history.state, '', boardHash(current.current));
      }
    };
    window.addEventListener('hashchange', on);
    return () => {
      window.removeEventListener('hashchange', on);
      cancel();
    };
  }, []);

  /** Apply a board change; the Filter (`debounce`) writes the URL later, the rest at once. */
  const change = (patch: Partial<BoardSettings>, debounce = false) => {
    current.current = { ...current.current, ...patch };
    setSettings(current.current);
    if (!debounce) {
      write();
      return;
    }
    cancel();
    pending.current = window.setTimeout(write, FILTER_WRITE_MS);
  };
  /** Land a pending Filter write now (blur, and before a row opens its job). */
  const flush = () => {
    if (pending.current !== undefined) write();
  };
  return { settings, change, flush };
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
  const { settings, change, flush } = useBoardSettings();
  const { show: status, repo, q: text } = settings;
  const boardHref = boardHash(settings);
  const [detailActivity, setDetailActivity] = useState<DetailActivity>('loading');
  const [ticketFilters, setTicketFilters] = useState<TicketFilters>(NO_FILTERS);
  const ticketMatch = TICKETS_ROUTE.exec(hash);
  const runsMatch = RUNS_ROUTE.test(hash);
  const agentsMatch = AGENTS_ROUTE.test(hash);
  const usageMatch = USAGE_ROUTE.test(hash);
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
  // A repository the loaded list does not have (a stale or edited link) means All repositories.
  const unknownRepo = board.data !== null && repo !== '' && !board.data.repos.includes(repo);
  useEffect(() => {
    if (unknownRepo) change({ repo: '' });
  }, [unknownRepo]); // `change` reads only refs
  const error = board.error === null ? null : failureText(board.error);

  // The shared header's one runner poll, on every section: the Factory status box and whether
  // the installed build lags its checkout. A failed request shows no build warning: that is
  // advice, never an error.
  const runner = usePolled(fetchRunner, refreshMs);
  const build = runner.data?.build ?? null;

  const jobMatch = parseJobRoute(hash);
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
            href={boardHref}
            sx={{ fontWeight: weight.bold, color: 'inherit', textDecoration: 'none' }}
          >
            orch factory
          </Typography>
          <Box component="nav" aria-label="Sections" sx={{ display: 'flex', gap: 0.5 }}>
            {SECTIONS.map((s) => (
              <Button
                key={s.label}
                href={s.label === 'Jobs' ? boardHref : s.href}
                variant={s.label === section ? 'outlined' : 'text'}
                color="inherit"
                aria-current={s.label === section ? 'page' : undefined}
              >
                {s.label}
              </Button>
            ))}
          </Box>
          <Help refreshMs={refreshMs} />
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
                      change({ show: pressed ? 'current' : c.filter });
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
                  change({ q: e.target.value }, true);
                }}
                onBlur={flush}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ minWidth: 200 }}
              />
              <Pick
                size="small"
                label="Repository"
                value={repo}
                onChange={(v) => {
                  change({ repo: v });
                }}
                options={repos}
                all="All repositories"
                width={180}
              />
              <Pick
                size="small"
                label="Show"
                value={status}
                onChange={(v) => {
                  change({ show: v as StatusFilter });
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
            id={jobMatch.id}
            choose={jobMatch.choose}
            tab={jobMatch.tab}
            round={jobMatch.round}
            reviewer={jobMatch.reviewer}
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
            sort={settings.sort}
            onSort={(sort) => {
              change({ sort });
            }}
            beforeOpen={flush}
          />
        )}
      </Box>
    </Box>
  );
}
