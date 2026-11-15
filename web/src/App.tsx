import {
  Alert,
  AppBar,
  Box,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Toolbar,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import type { BoardRow } from '../../src/server/types.ts';
import { JobBoard } from './JobBoard.tsx';
import { JobDetail } from './JobDetail.tsx';
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

const STATUS_FILTERS = ['all', 'active', 'needs human', 'finished', 'cancelled'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function matches(row: BoardRow, f: StatusFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'active':
      return !['blocked', 'completed', 'cancelled'].includes(row.liveness);
    case 'needs human':
      return row.liveness === 'blocked';
    case 'finished':
      return row.liveness === 'completed' || row.liveness === 'cancelled';
    case 'cancelled':
      return row.liveness === 'cancelled';
  }
}

export function App({ refreshMs = 4000 }: { refreshMs?: number }) {
  const hash = useHashRoute();
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState<string>('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    Promise.all([fetchBoard(repo || undefined), fetchRepos()]).then(
      ([b, r]) => {
        setRows(b);
        setRepos(r);
        setError(null);
        setNow(Date.now());
      },
      (err: unknown) => {
        setError(err instanceof ApiFailure ? `${err.type}: ${err.message}` : String(err));
      },
    );
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
  const visible = (rows ?? []).filter((r) => matches(r, status));
  const counts = {
    running: (rows ?? []).filter((r) => r.liveness === 'running').length,
    stale: (rows ?? []).filter((r) => r.liveness === 'stale').length,
    blocked: (rows ?? []).filter((r) => r.liveness === 'blocked').length,
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar
        position="sticky"
        color="default"
        elevation={0}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
      >
        <Toolbar variant="dense" sx={{ gap: 1.5, flexWrap: 'wrap' }}>
          <Typography
            variant="subtitle1"
            component="a"
            href="#/"
            sx={{ fontWeight: 700, color: 'inherit', textDecoration: 'none' }}
          >
            orch factory
          </Typography>
          <Stack direction="row" spacing={0.5} aria-label="Summary">
            <Chip
              label={`${String(counts.running)} running`}
              color="primary"
              variant={counts.running ? 'filled' : 'outlined'}
            />
            <Chip
              label={`${String(counts.stale)} stale`}
              color="warning"
              variant={counts.stale ? 'filled' : 'outlined'}
            />
            <Chip
              label={`${String(counts.blocked)} need human`}
              color="error"
              variant={counts.blocked ? 'filled' : 'outlined'}
            />
          </Stack>
          <Box sx={{ flex: 1 }} />
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
                  {s}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Toolbar>
      </AppBar>
      {error && (
        <Alert severity="error" sx={{ m: 1 }} role="alert">
          {error}
        </Alert>
      )}
      <Box component="main" sx={{ flex: 1 }}>
        {jobMatch ? (
          <JobDetail id={jobMatch[1] ?? ''} refreshMs={refreshMs} />
        ) : rows === null ? (
          <Typography sx={{ p: 3 }} color="text.secondary">
            Loading…
          </Typography>
        ) : (
          <JobBoard rows={visible} now={now} />
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
