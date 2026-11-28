import {
  Alert,
  Box,
  LinearProgress,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { RunsView, TokenCounts, TrustRow } from '../../src/server/types.ts';
import { w, weight } from './Usage.tsx';
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

const pct = (x: number | null) => (x === null ? UNAVAILABLE : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null) => (x === null ? UNAVAILABLE : String(x));
const seconds = (s: number | null) => duration(s === null ? null : s * 1000);
/** A ticket's tokens as their cost weight (the Usage section's rule); Unavailable when null. */
const cost = (c: TokenCounts | null) => (c === null ? UNAVAILABLE : w(weight(c)));

const TRUST_ROWS: [string, (r: TrustRow) => string][] = [
  ['Finished jobs', (r) => String(r.finishedJobs)],
  ['Escalation rate (escalated / finished)', (r) => pct(r.escalationRate)],
  ['First-pass rate (first pass / merged)', (r) => pct(r.firstPassRate)],
  ['Rounds (median)', (r) => num(r.rounds.median)],
  ['Rounds (max)', (r) => num(r.rounds.max)],
  ['CI repairs (median)', (r) => num(r.ciRepairs.median)],
  ['CI repairs (max)', (r) => num(r.ciRepairs.max)],
  ['Elapsed (median)', (r) => duration(r.elapsedMs)],
  ['Agent time (median)', (r) => seconds(r.agentSeconds)],
  [
    'Tokens (median, plain total, not weighted)',
    (r) => (r.tokens === null ? UNAVAILABLE : w(r.tokens)),
  ],
];

const TICKET_COLUMNS: [string, (t: RunsView['tickets'][number]) => React.ReactNode][] = [
  ['Ticket', (t) => `${t.ticketKey} ${t.title}`],
  ['Job', (t) => <Link href={`#/jobs/${t.jobId}`}>{t.jobId}</Link>],
  ['Mode', (t) => t.mode],
  ['Jobs', (t) => String(t.jobCount)],
  ['Rounds', (t) => String(t.rounds)],
  ['CI repairs', (t) => String(t.ciRepairs)],
  ['Escalated', (t) => (t.escalated ? 'Yes' : 'No')],
  ['Elapsed', (t) => duration(t.elapsedMs)],
  ['Agent time', (t) => seconds(t.agentSeconds)],
  ['Tokens', (t) => cost(t.tokens)],
];

function TrustTables({ data }: { data: RunsView }) {
  const recorded = data.tickets.filter((t) => t.tokens !== null).length;
  return (
    <>
      <Typography variant="subtitle1" component="h2" sx={{ mt: 3 }}>
        Trust and cost
      </Typography>
      <TableContainer>
        <Table size="small" aria-label="Trust and cost">
          <TableHead>
            <TableRow>
              <TableCell>Metric</TableCell>
              <TableCell align="right">Full</TableCell>
              <TableCell align="right">Fast</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {TRUST_ROWS.map(([k, f]) => (
              <TableRow key={k}>
                <TableCell component="th" scope="row">
                  {k}
                </TableCell>
                <TableCell align="right">{f(data.trust.full)}</TableCell>
                <TableCell align="right">{f(data.trust.fast)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="caption" color="text.secondary" component="p">
        {`Per-ticket medians and maxima cover the merged tickets with a recorded value; tokens recorded for ${String(recorded)} of ${String(data.tickets.length)} merged tickets.`}
      </Typography>
      <Typography variant="subtitle1" component="h2" sx={{ mt: 3 }}>
        Merged tickets
      </Typography>
      <TableContainer>
        <Table size="small" aria-label="Merged tickets">
          <TableHead>
            <TableRow>
              {TICKET_COLUMNS.map(([name]) => (
                <TableCell key={name}>{name}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {data.tickets.map((t) => (
              <TableRow key={t.jobId}>
                {TICKET_COLUMNS.map(([name, f]) => (
                  <TableCell key={name}>{f(t)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

export function RunsPage({ refreshMs = 4000 }: { refreshMs?: number }) {
  const { data, error } = usePolled(fetchRuns, refreshMs);
  const rows: [string, string][] = data
    ? [
        ['Total jobs', String(data.total)],
        ['Completed', String(data.completed)],
        ['Cancelled', String(data.cancelled)],
        ['Active', String(data.active)],
        ['Completion rate (completed / finished)', pct(data.completionRate)],
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
      {data && <TrustTables data={data} />}
    </Polled>
  );
}
