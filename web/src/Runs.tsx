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
import { useEffect, useState } from 'react';

import { fetchRuns } from './api.ts';
import { elapsedCell } from './format.ts';

export const UNAVAILABLE = 'Unavailable';

/** Fetch now and every `refreshMs` while the tab is visible; the last good value stays shown. */
export function usePolled<T>(
  fetcher: () => Promise<T>,
  refreshMs: number,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => {
      fetcher().then(
        (d) => {
          setData(d);
          setError(null);
        },
        (err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, refreshMs);
    return () => {
      clearInterval(timer);
    };
  }, [fetcher, refreshMs]);
  return { data, error };
}

/** Loading bar before the first answer, the error above whatever was last shown. */
export function Polled({
  label,
  error,
  loaded,
  children,
}: {
  label: string;
  error: string | null;
  loaded: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6" component="h1" gutterBottom>
        {label}
      </Typography>
      {error && (
        <Alert severity="error" role="alert" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {loaded ? children : !error && <LinearProgress aria-label={`Loading ${label}`} />}
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
