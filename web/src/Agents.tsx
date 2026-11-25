import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import type { AgentTiming, ReviewerRow, StageRow } from '../../src/server/types.ts';
import { duration, Polled, usePolled } from './Runs.tsx';
import { fetchAgents } from './api.ts';

type Row = AgentTiming & { role: string; runs: number };

/** A count with its share of Runs; no share when there are no runs. */
const share = (n: number, runs: number) =>
  runs === 0 ? String(n) : `${String(n)} (${String(Math.round((n / runs) * 100))}%)`;

const REVIEWER_COLUMNS: [string, (r: ReviewerRow) => string][] = [
  ['Pass', (r) => String(r.pass)],
  ['Changes', (r) => share(r.changes, r.runs)],
];

const STAGE_COLUMNS: [string, (r: StageRow) => string][] = [
  ['Completed', (r) => String(r.completed)],
  ['Failed', (r) => String(r.failed)],
  ['Escalated', (r) => String(r.escalated)],
  ['Sent back', (r) => String(r.sentBack)],
  ['Cancelled', (r) => String(r.cancelled)],
  ['Interrupted', (r) => String(r.interrupted)],
];

function AgentTable<R extends Row>({
  label,
  rows,
  columns,
  note,
}: {
  label: string;
  rows: R[];
  columns: [string, (r: R) => string][];
  note?: string;
}) {
  const unmeasured = rows.filter((r) => r.unmeasured > 0);
  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="subtitle1" component="h2">
        {label}
      </Typography>
      <TableContainer>
        <Table size="small" aria-label={label}>
          <TableHead>
            <TableRow>
              <TableCell>Role</TableCell>
              <TableCell align="right">Runs</TableCell>
              {columns.map(([name]) => (
                <TableCell key={name} align="right">
                  {name}
                </TableCell>
              ))}
              <TableCell align="right">Average</TableCell>
              <TableCell align="right">Median</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.role}>
                <TableCell component="th" scope="row">
                  {r.role}
                </TableCell>
                <TableCell align="right">{String(r.runs)}</TableCell>
                {columns.map(([name, cell]) => (
                  <TableCell key={name} align="right">
                    {cell(r)}
                  </TableCell>
                ))}
                <TableCell align="right">{duration(r.averageMs)}</TableCell>
                <TableCell align="right">{duration(r.medianMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {note && (
        <Typography variant="caption" color="text.secondary" component="p">
          {note}
        </Typography>
      )}
      {unmeasured.length > 0 && (
        <Typography variant="caption" color="text.secondary" component="p">
          Runs without a duration, left out of Average and Median:{' '}
          {unmeasured.map((r) => `${r.role} ${String(r.unmeasured)}`).join(', ')}.
        </Typography>
      )}
    </Box>
  );
}

export function AgentsPage({ refreshMs = 4000 }: { refreshMs?: number }) {
  const { data, error } = usePolled(fetchAgents, refreshMs);
  return (
    <Polled label="Agents" error={error} loaded={data !== null}>
      <AgentTable label="Reviewers" rows={data?.reviewers ?? []} columns={REVIEWER_COLUMNS} />
      <AgentTable
        label="Stages"
        rows={data?.stages ?? []}
        columns={STAGE_COLUMNS}
        note="Stage time includes coordinator work."
      />
    </Polled>
  );
}
