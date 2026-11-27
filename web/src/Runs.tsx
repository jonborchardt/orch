import {
  Alert,
  Box,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorText, fetchRuns } from './api.ts';
import { elapsedCell } from './format.ts';

export const UNAVAILABLE = 'Unavailable';

/**
 * Fetch now and every `refreshMs` while the tab is visible; the last good value stays shown. A
 * null fetcher polls nothing. A response from a superseded fetcher is dropped. `error` is the raw
 * rejection, cleared by the next good response; `reload()` resolves to the fresh value, or null.
 * `updatedAt` is the time of the latest good response, null before the first.
 */
export function usePolled<T>(
  fetcher: (() => Promise<T>) | null,
  refreshMs: number,
): {
  data: T | null;
  error: unknown;
  loading: boolean;
  updatedAt: number | null;
  reload: () => Promise<T | null>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const current = useRef(fetcher);
  const reload = useCallback(async () => {
    if (!fetcher) return null;
    setInFlight((n) => n + 1);
    try {
      const d = await fetcher();
      if (current.current !== fetcher) return null;
      setData(d);
      setError(null);
      setUpdatedAt(Date.now());
      return d;
    } catch (err) {
      if (current.current === fetcher) setError(err);
      return null;
    } finally {
      setInFlight((n) => n - 1);
    }
  }, [fetcher]);
  useEffect(() => {
    current.current = fetcher;
    if (!fetcher) return;
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [fetcher, reload, refreshMs]);
  return { data, error, loading: inFlight > 0, updatedAt, reload };
}

/** Loading bar before the first answer, the error above whatever was last shown. */
export function Polled({
  label,
  error,
  loaded,
  children,
}: {
  label: string;
  /** Raw, as `usePolled` returns it. */
  error: unknown;
  loaded: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6" component="h1" gutterBottom>
        {label}
      </Typography>
      {error !== null && (
        <Alert severity="error" role="alert" sx={{ mb: 1 }}>
          {errorText(error)}
        </Alert>
      )}
      {loaded ? children : error === null && <LinearProgress aria-label={`Loading ${label}`} />}
    </Box>
  );
}

export const duration = (ms: number | null) => (ms === null ? UNAVAILABLE : elapsedCell(ms));

export function RunsPage({ refreshMs = 4000 }: { refreshMs?: number }) {
  const { data, error } = usePolled(fetchRuns, refreshMs);
  const rows: [string, string][] = data
    ? [
        ['Total jobs', String(data.total)],
        ['Completed', String(data.completed)],
        ['Cancelled', String(data.cancelled)],
        ['Active', String(data.active)],
        [
          'Completion rate (completed / finished)',
          data.completionRate === null ? UNAVAILABLE : `${(data.completionRate * 100).toFixed(1)}%`,
        ],
        ['Average duration (completed)', duration(data.durationMs.average)],
        ['Median duration (completed)', duration(data.durationMs.median)],
        ['Completed jobs with unknown duration', String(data.durationUnknown)],
        [
          'Completed per hour',
          data.completedPerHour === null ? UNAVAILABLE : data.completedPerHour.toFixed(2),
        ],
      ]
    : [];
  return (
    <Polled label="Runs" error={error} loaded={data !== null}>
      <TableContainer>
        <Table size="small" aria-label="Runs">
          <TableBody>
            {rows.map(([k, v]) => (
              <TableRow key={k}>
                <TableCell component="th" scope="row">
                  {k}
                </TableCell>
                <TableCell align="right">{v}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Polled>
  );
}
