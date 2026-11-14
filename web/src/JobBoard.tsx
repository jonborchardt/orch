import {
  Chip,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';

import type { BoardRow } from '../../src/server/types.ts';
import { CiChip } from './Ci.tsx';
import { BlockerText, CopyResume, StatusChip } from './Status.tsx';
import { ago, elapsed, verdictColor } from './format.ts';

export function JobBoard({ rows, now }: { rows: BoardRow[]; now: number }) {
  if (rows.length === 0) {
    return (
      <Typography sx={{ p: 3 }} color="text.secondary" role="status">
        No jobs yet. Start one from a Claude Code session in any repository with
        <code> /factory &lt;request&gt;</code>, or <code>orch factory start</code>.
      </Typography>
    );
  }
  return (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Factory jobs" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Repository</TableCell>
            <TableCell>Job</TableCell>
            <TableCell>Stage</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Session</TableCell>
            <TableCell>Branch / worktree</TableCell>
            <TableCell align="center">Round</TableCell>
            <TableCell>Reviews</TableCell>
            <TableCell align="right">Blocking</TableCell>
            <TableCell align="right">Elapsed</TableCell>
            <TableCell>Updated</TableCell>
            <TableCell>PR / CI</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} hover data-job-id={r.id}>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                <Tooltip title={r.repoPath}>
                  <span>{r.repo}</span>
                </Tooltip>
              </TableCell>
              <TableCell sx={{ minWidth: 220 }}>
                <Link href={`#/jobs/${r.id}`} underline="hover" sx={{ fontWeight: 600 }}>
                  {r.title}
                </Link>
                <Typography component="div" variant="caption" color="text.secondary">
                  {r.id}
                </Typography>
              </TableCell>
              <TableCell>
                <Chip label={r.stage} variant="outlined" />
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                  <StatusChip state={r.liveness} />
                  {r.resume?.command && (
                    <CopyResume
                      id={r.id}
                      command={r.resume.command}
                      checkout={r.repoPath}
                      compact
                    />
                  )}
                </Stack>
                {r.blocker && <BlockerText blocker={r.blocker} compact />}
                {r.blocker && r.resume?.heldBy && (
                  <Typography component="div" variant="caption" color="text.secondary">
                    Resume unavailable: session {r.resume.heldBy.session} holds a live lease
                  </Typography>
                )}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                {r.owner ? (
                  <Tooltip
                    title={
                      r.owner.live
                        ? `lease until ${r.owner.leaseExpiresAt ?? '?'}`
                        : `lease lapsed ${ago(r.owner.leaseExpiresAt, now)}`
                    }
                  >
                    <span>
                      {r.owner.session}
                      {r.owner.live ? '' : ' (lapsed)'}
                    </span>
                  </Tooltip>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    none
                  </Typography>
                )}
              </TableCell>
              <TableCell sx={{ maxWidth: 260 }}>
                <Typography variant="body2" noWrap title={r.branch ?? ''}>
                  {r.branch ?? '—'}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  component="div"
                  title={r.worktreePath ?? ''}
                >
                  {r.worktreePath ?? ''}
                </Typography>
              </TableCell>
              <TableCell align="center">
                {r.round}/{r.maxRounds}
              </TableCell>
              <TableCell>
                <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {r.reviews.map((v) => (
                    <Chip
                      key={v.reviewer}
                      label={`${v.reviewer}: ${v.verdict ?? 'pending'}`}
                      color={verdictColor(v.verdict)}
                      variant={v.verdict ? 'filled' : 'outlined'}
                    />
                  ))}
                </Stack>
              </TableCell>
              <TableCell align="right">
                {r.blocking === null ? (
                  '—'
                ) : (
                  <Chip label={r.blocking} color={r.blocking > 0 ? 'error' : 'success'} />
                )}
              </TableCell>
              <TableCell align="right">{elapsed(r.elapsedMs)}</TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{ago(r.updatedAt, now)}</TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                {r.pr.url ? (
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Link href={r.pr.url} target="_blank" rel="noreferrer noopener">
                      PR ({r.pr.state})
                    </Link>
                    <CiChip ci={r.ci} compact />
                  </Stack>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    no PR
                  </Typography>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
