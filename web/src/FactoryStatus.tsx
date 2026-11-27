/**
 * The shared header's Factory status box: what `orch status` prints, read-only, from `App`'s one
 * `GET /api/runner` poll, with when it last answered. Controllers are started and stopped from
 * the CLI; there is no control and no Retry here.
 */
import { Alert, Box, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import type { ControllerStatus, RunnerStatus } from '../../src/server/types.ts';
import { errorText } from './api.ts';
import { ago } from './format.ts';
import { ticketHref } from './ticketState.ts';
import { statusColor, weight } from './theme.ts';

const RUNNER_COLOR = { running: statusColor.running, interrupted: 'warning' } as const;
const ROW_SX = { alignItems: 'center', flexWrap: 'wrap', overflowWrap: 'anywhere' } as const;

/** One controller: its state, scope, ticket and job, stop requests, and what it does next. */
function ControllerLine({ c }: { c: ControllerStatus }) {
  const cur = c.current;
  return (
    <Box role="group" aria-label={`Controller for ${c.scope}`} data-controller={c.scope}>
      <Stack direction="row" spacing={1} useFlexGap sx={ROW_SX}>
        <Typography sx={{ fontWeight: weight.bold }}>Factory</Typography>
        <Chip label={c.state} color={RUNNER_COLOR[c.state]} data-runner={c.state} />
        <Typography color="text.secondary">
          {c.mode === 'ticket'
            ? `one ticket (orch do) in ${c.scope}`
            : c.mode === 'queue'
              ? `queue of ${c.scope}`
              : c.scope}
        </Typography>
        {cur && (
          <Typography>
            ticket <Link href={ticketHref(Number(cur.ticket))}>{cur.ticket}</Link>
            {cur.job && (
              <>
                {' · '}
                <Link href={`#/jobs/${cur.job}`}>{cur.job}</Link>
                {cur.stage && ` at ${cur.stage}`}
                {cur.status && ` (${cur.status})`}
              </>
            )}
            {cur.repo && ` · ${cur.repo}`}
            {cur.waiting && ` · waiting for ${cur.waiting === 'human' ? 'a person' : cur.waiting}`}
          </Typography>
        )}
        {c.stop.now && <Chip color="warning" label="stop requested: now" />}
        {c.stop.next && <Chip color="warning" label="stop requested: after this ticket" />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {c.next}
      </Typography>
    </Box>
  );
}

export function FactoryStatus({
  runner,
  error,
  updatedAt,
  refreshMs,
}: {
  /** `usePolled`'s last good value, error, and success time for `fetchRunner`. */
  runner: RunnerStatus | null;
  error: unknown;
  updatedAt: number | null;
  refreshMs: number;
}) {
  // The tick lives here, not in App, so only this box re-renders each second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);

  if (runner === null && error === null) return null;
  const iso = updatedAt === null ? null : new Date(updatedAt).toISOString();
  const at =
    iso === null ? null : (
      <time dateTime={iso} title={iso}>
        {ago(iso, now)}
      </time>
    );
  const hung = error === null && updatedAt !== null && now - updatedAt > 3 * refreshMs;
  const retries = `retries every ${String(refreshMs / 1000)} s.`;
  const warn = error !== null || hung;
  return (
    // While warning, the Alert is the frame; the outer border would double it.
    <Paper
      component="section"
      aria-label="Factory status"
      variant={warn ? 'elevation' : 'outlined'}
      elevation={0}
      sx={{ m: 1, p: 1 }}
    >
      {warn && (
        // Not an alert: it repeats every poll and is advice about freshness. The live region is
        // only the static sentence; the ticking time sits outside it so it is not re-announced.
        <Alert
          severity="warning"
          role="none"
          data-warning
          icon={<span aria-hidden="true">⚠</span>}
          sx={{ mb: runner ? 1 : 0 }}
        >
          <span role="status">
            {error !== null
              ? `Factory status could not be read: ${errorText(error)}; `
              : 'Not updating: the last request has not answered; '}
            {retries}
          </span>
          {at && <> Last updated {at}.</>}
        </Alert>
      )}
      {runner && (
        <>
          {runner.controllers.length === 0 ? (
            <Stack direction="row" spacing={1} useFlexGap sx={ROW_SX}>
              <Typography sx={{ fontWeight: weight.bold }}>Factory</Typography>
              <Chip label="idle" data-runner="idle" />
              <Typography variant="body2" color="text.secondary">
                {/* The same sentence as IDLE_NEXT in src/ops/run.ts; web/ imports only types. */}
                Nothing is running. orch start resumes a stranded in-progress ticket first, then
                takes the next ready one.
              </Typography>
            </Stack>
          ) : (
            <Stack spacing={1} sx={{ mb: 0.5 }}>
              {runner.controllers.map((c) => (
                <ControllerLine key={c.scope} c={c} />
              ))}
            </Stack>
          )}
          {runner.last && (
            <Typography variant="body2" color="text.secondary">
              Last session ended <time dateTime={runner.last.at}>{ago(runner.last.at, now)}</time>:{' '}
              {runner.last.reason} ({String(runner.last.completed)} of{' '}
              {String(runner.last.attempted)} attempted tickets done, {runner.last.scope}).
            </Typography>
          )}
          {at && !warn && (
            <Typography variant="caption" component="p" color="text.secondary">
              Updated {at}
            </Typography>
          )}
        </>
      )}
    </Paper>
  );
}
