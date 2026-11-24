import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import { duration, Polled, usePolled } from './Runs.tsx';
import { fetchAgents } from './api.ts';

const COUNTS = ['invocations', 'success', 'failure', 'other', 'open', 'measured'] as const;

export function AgentsPage({ refreshMs = 4000 }: { refreshMs?: number }) {
  const { data, error } = usePolled(fetchAgents, refreshMs);
  return (
    <Polled label="Agents" error={error} loaded={data !== null}>
      <TableContainer>
        <Table size="small" aria-label="Agents">
          <TableHead>
            <TableRow>
              <TableCell>Role</TableCell>
              <TableCell>Source</TableCell>
              <TableCell align="right">Invocations</TableCell>
              <TableCell align="right">Success</TableCell>
              <TableCell align="right">Failure</TableCell>
              <TableCell align="right">Other</TableCell>
              <TableCell align="right">Open</TableCell>
              <TableCell align="right">Measured</TableCell>
              <TableCell align="right">Average</TableCell>
              <TableCell align="right">Median</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(data ?? []).map((r) => (
              <TableRow key={r.role}>
                <TableCell component="th" scope="row">
                  {r.role}
                </TableCell>
                {r.source === 'none' ? (
                  <TableCell colSpan={9}>Not recorded</TableCell>
                ) : (
                  <>
                    <TableCell>
                      {r.source === 'reviews'
                        ? 'review runs'
                        : 'stage time (includes coordinator work)'}
                    </TableCell>
                    {COUNTS.map((k) => (
                      <TableCell key={k} align="right">
                        {String(r[k])}
                      </TableCell>
                    ))}
                    <TableCell align="right">{duration(r.averageMs)}</TableCell>
                    <TableCell align="right">{duration(r.medianMs)}</TableCell>
                  </>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Typography variant="caption" color="text.secondary">
        Runtimes count only invocations with an end and a duration above zero; the rest are
        unmeasured.
      </Typography>
    </Polled>
  );
}
