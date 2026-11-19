import {
  Alert,
  AppBar,
  Box,
  Chip,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { BoardRow } from '../../src/server/types.ts';
import { JobBoard } from './JobBoard.tsx';
import { type DetailActivity, JobDetail } from './JobDetail.tsx';
import { ApiFailure, fetchBoard, fetchRepos } from './api.ts';

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
  { filter: 'running', label: 'running', color: 'primary' },
  { filter: 'stale', label: 'stale', color: 'warning' },
  { filter: 'needs human', label: 'need human', color: 'error' },
  { filter: 'failed', label: 'failed', color: 'error' },
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
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string>('');
  const [status, setStatus] = useState<StatusFilter>('current');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [inFlight, setInFlight] = useState(0);
  const [detailActivity, setDetailActivity] = useState<DetailActivity>('loading');

  const load = useCallback(() => {
    setInFlight((n) => n + 1);
    Promise.all([fetchBoard(repo || undefined), fetchRepos()])
      .then(
        ([b, r]) => {
          setRows(b);
          setRepos(r);
          setError(null);
          setNow(Date.now());
        },
        (err: unknown) => {
          setError(err instanceof ApiFailure ? `${err.type}: ${err.message}` : String(err));
        },
      )
      .finally(() => {
        setInFlight((n) => n - 1);
      });
  }, [repo]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [load, refreshMs]);

  const jobMatch = /^#\/jobs\/(job-[0-9a-f]{8})$/.exec(hash);
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
  const boardPolling = inFlight > 0 && rows !== null;
  const refreshing = jobMatch
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
            sx={{ fontWeight: 700, color: 'inherit', textDecoration: 'none' }}
          >
            orch factory
          </Typography>
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
          {/* Board-only controls, wrapping as one group; detail routes have nothing to filter. */}
          {!jobMatch && (
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
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <InputLabel id="repo-label" shrink>
                  Repository
                </InputLabel>
                <Select
                  labelId="repo-label"
                  label="Repository"
                  value={repo}
                  onChange={(e) => {
                    setRepo(e.target.value);
                  }}
                  displayEmpty
                  notched
                >
                  <MenuItem value="">All repositories</MenuItem>
                  {repos.map((r) => (
                    <MenuItem key={r} value={r}>
                      {r}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 140 }}>
                <InputLabel id="status-label">Show</InputLabel>
                <Select
                  labelId="status-label"
                  label="Show"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                  }}
                >
                  {STATUS_FILTERS.map((s) => (
                    <MenuItem key={s} value={s}>
                      {counts ? `${s} (${String(counts[s])})` : s}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Box>
          )}
        </Toolbar>
        {/* Fixed-height slot so the page never shifts when a poll starts or ends. */}
        <Box sx={{ height: 4 }}>
          {refreshing && <LinearProgress aria-label="Refreshing" sx={{ height: 4 }} />}
        </Box>
      </AppBar>
      {error && (
        <Alert severity="error" sx={{ m: 1 }} role="alert">
          {error}
        </Alert>
      )}
      <Box component="main" sx={{ flex: 1 }}>
        {jobMatch ? (
          <JobDetail id={jobMatch[1] ?? ''} refreshMs={refreshMs} onActivity={setDetailActivity} />
        ) : rows === null ? (
          // A failed first load shows only the error alert above, not a bar that never ends.
          !error && (
            <Box sx={{ p: 3 }}>
              <LinearProgress aria-label="Loading jobs" />
            </Box>
          )
        ) : (
          <JobBoard rows={visible} total={rows.length} now={now} onChanged={load} />
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
