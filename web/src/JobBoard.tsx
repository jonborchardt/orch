import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { type ReactNode, useState } from 'react';

import type { BoardRow } from '../../src/server/types.ts';
import { ApiFailure, postAction } from './api.ts';
import { CiChip } from './Ci.tsx';
import { BlockerText, CopyResume, StatusChip, Supersession } from './Status.tsx';
import { ago, elapsed, verdictColor } from './format.ts';

interface Column {
  id: string;
  label: string;
  /** Job and Status always show; the rest can be hidden from the Columns menu. */
  hideable: boolean;
  align?: 'center' | 'right';
  sortValue?: (r: BoardRow) => string | number;
  sx?: object;
  cell: (r: BoardRow, now: number) => ReactNode;
}

const COLUMNS: Column[] = [
  {
    id: 'repo',
    label: 'Repository',
    hideable: true,
    sortValue: (r) => r.repo,
    sx: { whiteSpace: 'nowrap' },
    cell: (r) => (
      <Tooltip title={r.repoPath}>
        <span>{r.repo}</span>
      </Tooltip>
    ),
  },
  {
    id: 'job',
    label: 'Job',
    hideable: false,
    sortValue: (r) => r.title.toLowerCase(),
    sx: { minWidth: 220 },
    cell: (r) => (
      <>
        <Link href={`#/jobs/${r.id}`} underline="hover" sx={{ fontWeight: 600 }}>
          {r.title}
        </Link>
        <Typography component="div" variant="caption" color="text.secondary">
          {r.id}
        </Typography>
        <Supersession supersededBy={r.supersededBy} supersedes={r.supersedes} />
      </>
    ),
  },
  {
    id: 'stage',
    label: 'Stage',
    hideable: true,
    sortValue: (r) => r.stage,
    cell: (r) => <Chip label={r.stage} variant="outlined" />,
  },
  {
    id: 'status',
    label: 'Status',
    hideable: false,
    sortValue: (r) => r.liveness,
    sx: { whiteSpace: 'nowrap' },
    cell: (r) => (
      <>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <StatusChip state={r.liveness} />
          {r.archivedAt !== null && <Chip label="archived" size="small" />}
          {r.resume?.command && (
            <CopyResume id={r.id} command={r.resume.command} checkout={r.repoPath} compact />
          )}
        </Stack>
        {r.blocker && <BlockerText blocker={r.blocker} compact />}
        {r.blocker && r.resume?.heldBy && (
          <Typography component="div" variant="caption" color="text.secondary">
            Resume unavailable: session {r.resume.heldBy.session} holds a live lease
          </Typography>
        )}
      </>
    ),
  },
  {
    id: 'session',
    label: 'Session',
    hideable: true,
    sortValue: (r) => r.owner?.session ?? '',
    sx: { whiteSpace: 'nowrap' },
    cell: (r, now) =>
      r.owner ? (
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
      ),
  },
  {
    id: 'branch',
    label: 'Branch / worktree',
    hideable: true,
    sortValue: (r) => r.branch ?? '',
    sx: { maxWidth: 260 },
    cell: (r) => (
      <>
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
      </>
    ),
  },
  {
    id: 'round',
    label: 'Round',
    hideable: true,
    align: 'center',
    sortValue: (r) => r.round,
    cell: (r) => `${String(r.round)}/${String(r.maxRounds)}`,
  },
  {
    id: 'reviews',
    label: 'Reviews',
    hideable: true,
    cell: (r) => (
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
    ),
  },
  {
    id: 'blocking',
    label: 'Blocking',
    hideable: true,
    align: 'right',
    sortValue: (r) => r.blocking ?? -1,
    cell: (r) =>
      r.blocking === null ? (
        '—'
      ) : (
        <Chip label={r.blocking} color={r.blocking > 0 ? 'error' : 'success'} />
      ),
  },
  {
    id: 'elapsed',
    label: 'Elapsed',
    hideable: true,
    align: 'right',
    sortValue: (r) => r.elapsedMs,
    cell: (r) => elapsed(r.elapsedMs),
  },
  {
    id: 'updated',
    label: 'Updated',
    hideable: true,
    sortValue: (r) => r.updatedAt,
    sx: { whiteSpace: 'nowrap' },
    cell: (r, now) => ago(r.updatedAt, now),
  },
  {
    id: 'pr',
    label: 'PR / CI',
    hideable: true,
    sortValue: (r) => r.pr.state ?? '',
    sx: { whiteSpace: 'nowrap' },
    cell: (r) =>
      r.pr.url ? (
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
      ),
  },
];

/** Per-browser view preference, not job state. */
export const HIDDEN_COLUMNS_KEY = 'orch.board.hiddenColumns';
const DEFAULT_HIDDEN = ['repo', 'session', 'branch'];

function readHidden(): string[] {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(HIDDEN_COLUMNS_KEY) ?? 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : DEFAULT_HIDDEN;
  } catch {
    return DEFAULT_HIDDEN;
  }
}

type Sort = { id: string; dir: 'asc' | 'desc' } | null;

function sorted(rows: BoardRow[], sort: Sort): BoardRow[] {
  const key = COLUMNS.find((c) => c.id === sort?.id)?.sortValue;
  if (!sort || !key) return rows; // no sort chosen: the server's order
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

const finished = (r: BoardRow) => r.status === 'completed' || r.status === 'cancelled';

export function JobBoard({
  rows,
  now,
  onChanged,
}: {
  rows: BoardRow[];
  now: number;
  onChanged: () => void;
}) {
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const [sort, setSort] = useState<Sort>(null);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [target, setTarget] = useState<BoardRow | null>(null);

  if (rows.length === 0) {
    return (
      <Typography sx={{ p: 3 }} color="text.secondary" role="status">
        No jobs yet. Start one from a Claude Code session in any repository with
        <code> /factory &lt;request&gt;</code>, or <code>orch factory start</code>.
      </Typography>
    );
  }
  const toggle = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    setHidden(next);
    window.localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify(next));
  };
  const columns = COLUMNS.filter((c) => !c.hideable || !hidden.includes(c.id));

  return (
    <>
      <Stack direction="row" sx={{ px: 1, pt: 0.5, justifyContent: 'flex-end' }}>
        <Button
          size="small"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(e) => {
            setMenu(e.currentTarget);
          }}
        >
          Columns
        </Button>
        <Menu
          anchorEl={menu}
          open={menu !== null}
          onClose={() => {
            setMenu(null);
          }}
          aria-label="Choose columns"
        >
          {COLUMNS.filter((c) => c.hideable).map((c) => (
            <MenuItem
              key={c.id}
              dense
              onClick={() => {
                toggle(c.id);
              }}
            >
              <Checkbox
                size="small"
                checked={!hidden.includes(c.id)}
                tabIndex={-1}
                disableRipple
                slotProps={{ input: { 'aria-label': `${c.label} column` } }}
              />
              <ListItemText primary={c.label} />
            </MenuItem>
          ))}
        </Menu>
      </Stack>
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label="Factory jobs" stickyHeader>
          <TableHead>
            <TableRow>
              {columns.map((c) => {
                const active = sort?.id === c.id;
                return (
                  <TableCell
                    key={c.id}
                    align={c.align}
                    sortDirection={active ? sort.dir : false}
                    aria-sort={
                      active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                  >
                    {c.sortValue ? (
                      <TableSortLabel
                        active={active}
                        direction={active ? sort.dir : 'asc'}
                        onClick={() => {
                          setSort({ id: c.id, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' });
                        }}
                      >
                        {c.label}
                      </TableSortLabel>
                    ) : (
                      c.label
                    )}
                  </TableCell>
                );
              })}
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted(rows, sort).map((r) => (
              <TableRow key={r.id} hover data-job-id={r.id}>
                {columns.map((c) => (
                  <TableCell key={c.id} align={c.align} sx={c.sx}>
                    {c.cell(r, now)}
                  </TableCell>
                ))}
                <TableCell>
                  {r.archivedAt !== null ? (
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => {
                        setTarget(r);
                      }}
                    >
                      Unarchive
                    </Button>
                  ) : (
                    finished(r) && (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => {
                          setTarget(r);
                        }}
                      >
                        Archive
                      </Button>
                    )
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {target && (
        <ArchiveDialog
          row={target}
          onClose={() => {
            setTarget(null);
          }}
          onDone={() => {
            setTarget(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/**
 * Confirm an archive or unarchive from the board. A freshly completed job usually still holds its
 * finishing session's lease, so the same takeover checkbox as the detail page is offered; the
 * server decides and re-checks either way.
 */
function ArchiveDialog({
  row,
  onClose,
  onDone,
}: {
  row: BoardRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const archive = row.archivedAt === null;
  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveOwner = row.owner?.live === true && row.owner.session !== 'dashboard';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Parameters<typeof postAction>[1] = { action: archive ? 'archive' : 'unarchive' };
      if (reason.trim()) body.reason = reason.trim();
      if (force) body.force = true;
      await postAction(row.id, body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiFailure ? `${err.type}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      aria-labelledby="row-archive-title"
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle id="row-archive-title">
        {archive ? 'Archive' : 'Unarchive'} {row.title} ({row.id})
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Reason (recorded in the job's events)"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
            slotProps={{ htmlInput: { maxLength: 500 } }}
            autoFocus
          />
          {liveOwner && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={force}
                  onChange={(e) => {
                    setForce(e.target.checked);
                  }}
                />
              }
              label={`Take the job from session ${row.owner?.session ?? ''} (its token stops working)`}
            />
          )}
          <Alert severity="info" variant="outlined">
            Archiving only hides a finished job from the board&apos;s default views; its state,
            worktree, branch, and artifacts are unchanged. Show: archived lists archived jobs.
          </Alert>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            void submit();
          }}
          disabled={busy}
        >
          Confirm
        </Button>
      </DialogActions>
    </Dialog>
  );
}
