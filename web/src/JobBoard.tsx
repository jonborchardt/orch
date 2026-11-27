import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
  Tooltip,
  Typography,
} from '@mui/material';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import type { BoardRow } from '../../src/server/types.ts';
import { ApiFailure, postAction } from './api.ts';
import { CiChip, PrPhaseChip } from './Ci.tsx';
import { ProgressStrip, RoundIndicator } from './Progress.tsx';
import {
  BlockerText,
  CopyResume,
  FastChip,
  FlakeText,
  StatusChip,
  Supersession,
} from './Status.tsx';
import { ago, byAttention, elapsedCell, prNumber, repoLabels, reviewRollup } from './format.ts';
import { jobHref } from './tabs.ts';
import { weight } from './theme.ts';

/** True when a row event came from the row's own cells, not an inner control or a portal (Snackbar, tooltip). */
function fromRowBody(e: { target: EventTarget; currentTarget: HTMLElement }): boolean {
  const t = e.target;
  if (!(t instanceof Element) || !e.currentTarget.contains(t)) return false;
  const control = t.closest('a, button, input, textarea, select, [tabindex]');
  return control === null || control === e.currentTarget;
}

/**
 * Below this viewport width the board is compact: low-value columns hide and the essential cells
 * wrap. Kept at 1024 or less, the jsdom window width, so unit tests see the full board.
 */
const COMPACT = 1024;
const below = (px: number) => `@media (max-width: ${String(px - 0.02)}px)`;

interface Column {
  id: string;
  label: string;
  /** Job and Status always show; the rest can be hidden from the Columns menu. */
  hideable: boolean;
  align?: 'center' | 'right';
  sortValue?: (r: BoardRow) => string | number;
  /** Header tooltip defining the column; the sort button keeps `label` as its name. */
  hint?: string;
  sx?: object;
  /**
   * Viewport width (px) below which the column is not rendered, on top of the Columns menu, so
   * Job, Status, PR / CI, and Actions stay on screen on narrow displays. Never set on those four.
   */
  hideBelow?: number;
  /** `repoLabel` is set only when the board spans several repositories. */
  cell: (
    r: BoardRow,
    now: number,
    repoLabel: string | undefined,
    onChanged: () => void,
  ) => ReactNode;
}

const COLUMNS: Column[] = [
  {
    id: 'repo',
    label: 'Repository',
    hideable: true,
    hideBelow: COMPACT,
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
    sx: { minWidth: 220, [below(COMPACT)]: { minWidth: 160 } },
    cell: (r, _now, repoLabel) => (
      <>
        <Link href={`#/jobs/${r.id}`} underline="hover" sx={{ fontWeight: weight.semibold }}>
          {r.title}
        </Link>
        <Typography component="div" variant="caption" color="text.secondary">
          {r.id}
          {repoLabel !== undefined && (
            // Own span so the id stays the caption's only direct text (tests and selection).
            <span>
              {' · '}
              {/* Hover and accessible name: the full repository identity. */}
              <Tooltip title={r.repo}>
                <span data-repo-label>{repoLabel}</span>
              </Tooltip>
            </span>
          )}
        </Typography>
        <Supersession supersededBy={r.supersededBy} supersedes={r.supersedes} />
      </>
    ),
  },
  {
    id: 'stage',
    label: 'Stage',
    hideable: true,
    hideBelow: 900,
    // Workflow order: a job with no known step first, completed jobs last.
    sortValue: (r) => r.progress.position,
    sx: { whiteSpace: 'nowrap' },
    cell: (r) => <ProgressStrip progress={r.progress} />,
  },
  {
    id: 'status',
    label: 'Status',
    hideable: false,
    sortValue: (r) => r.liveness,
    // Wraps at every width: a long "Resume unavailable" line must not push PR / CI off-screen.
    cell: (r) => (
      <>
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <StatusChip state={r.liveness} outcome={r.outcome} />
          {r.mode === 'fast' && <FastChip size="small" />}
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
        {r.flake && <FlakeText flake={r.flake} compact />}
      </>
    ),
  },
  {
    id: 'session',
    label: 'Session',
    hideable: true,
    hideBelow: COMPACT,
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
    hideBelow: COMPACT,
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
    hint: 'Review rounds used of the most allowed (N / M). The repairs line under it counts CI repairs used of the most allowed.',
    hideable: true,
    hideBelow: COMPACT,
    align: 'center',
    sortValue: (r) => r.round,
    cell: (r) => (
      <>
        <RoundIndicator round={r.round} maxRounds={r.maxRounds} />
        {(r.ci.repairs > 0 || r.ci.outcome === 'failing') && (
          <Typography component="div" variant="caption" color="text.secondary">
            repairs {r.ci.repairs}/{r.ci.maxRepairs}
          </Typography>
        )}
      </>
    ),
  },
  {
    id: 'reviews',
    label: 'Reviews',
    hint: "The current round's verdict rollup across reviewers, and the blocking count from its consolidated findings.",
    hideable: true,
    hideBelow: COMPACT,
    // The blocking count folded into this column; sorting by it keeps that capability.
    sortValue: (r) => r.blocking ?? -1,
    sx: { whiteSpace: 'nowrap' },
    cell: (r) => <ReviewsCell row={r} />,
  },
  {
    id: 'elapsed',
    label: 'Elapsed',
    hint: 'Wall-clock time from job creation until it completed or was cancelled (until now while active). Includes blocked and waiting time.',
    hideable: true,
    hideBelow: COMPACT,
    align: 'right',
    // Unknown spans sort together, after every known one when ascending.
    sortValue: (r) => r.elapsedMs ?? Infinity,
    cell: (r) => elapsedCell(r.elapsedMs),
  },
  {
    id: 'started',
    label: 'Started',
    hint: 'When the job first started a stage (not when it was created). Restarts keep the first time.',
    hideable: true,
    hideBelow: COMPACT,
    // ISO strings sort by time; unstarted jobs sort together, after every started one ascending.
    sortValue: (r) => r.startedAt ?? '￿',
    // May wrap: its width follows the clock (10:00 is wider than 9:59), so on one line it can
    // push Actions off a 1440px board.
    cell: (r) =>
      r.startedAt ? (
        <time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time>
      ) : (
        '—'
      ),
  },
  {
    id: 'updated',
    label: 'Updated',
    hint: "When the job row last changed, not the session's last activity.",
    hideable: true,
    hideBelow: COMPACT,
    sortValue: (r) => r.updatedAt,
    sx: { whiteSpace: 'nowrap' },
    cell: (r, now) => ago(r.updatedAt, now),
  },
  {
    id: 'pr',
    label: 'PR / CI',
    hint: "The PR phase and CI as orch last recorded them, not GitHub's live state. The board's poll never re-reads GitHub; from the dashboard only Merge or Refresh PR refresh it.",
    hideable: true,
    sortValue: (r) => r.pr.phase,
    // Wraps only on a compact board; the chips stay on one line where there is room.
    sx: { whiteSpace: 'nowrap', [below(COMPACT)]: { whiteSpace: 'normal' } },
    cell: (r, _now, _repoLabel, onChanged) =>
      r.pr.url ? (
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
        >
          <PrNumberLink url={r.pr.url} />
          {/* The CI chip already says "CI running/failing", with the head; don't repeat it. */}
          {r.pr.phase !== 'ci-running' && r.pr.phase !== 'ci-failing' && (
            <PhaseCell row={r} onChanged={onChanged} />
          )}
          {/* A completed job's outcome is the headline; a merged PR's passing CI adds nothing,
              and neither do the checks a human merged it before (never "CI pending"). */}
          {!(
            r.outcome?.kind === 'merged' &&
            (r.ci.status === 'passing' || r.ci.completion === 'merged')
          ) && <CiChip ci={r.ci} compact secondary={r.outcome !== null} />}
        </Stack>
      ) : (
        // role="img" so assistive technology reads the label instead of the dash.
        <Typography variant="caption" color="text.secondary" role="img" aria-label="no PR">
          —
        </Typography>
      ),
  },
];

/** The board's PR link: `#<n>`, named `PR #<n>`; plain `PR` when the URL carries no number. */
function PrNumberLink({ url }: { url: string }) {
  const n = prNumber(url);
  return (
    <Link
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={n ? `PR #${n}` : undefined}
    >
      {n ? `#${n}` : 'PR'}
    </Link>
  );
}

/** CSS-only width hiding for a column's header and body cells (see `Column.hideBelow`). */
function narrow(c: Column): object | undefined {
  return c.hideBelow === undefined ? undefined : { [below(c.hideBelow)]: { display: 'none' } };
}

/**
 * The PR phase chip; where the server allows Refresh PR it is a button that runs it, as the detail
 * page does (`force` on a finished job), with no confirm.
 */
function PhaseCell({ row, onChanged }: { row: BoardRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!row.pr.refreshable) return <PrPhaseChip phase={row.pr.phase} />;
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await postAction(
        row.id,
        finished(row) ? { action: 'refresh-pr', force: true } : { action: 'refresh-pr' },
      );
      onChanged();
    } catch (err) {
      setError(err instanceof ApiFailure ? `${err.type}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PrPhaseChip
        phase={row.pr.phase}
        disabled={busy}
        onClick={() => {
          void refresh();
        }}
      />
      {error && (
        <Typography
          component="div"
          variant="caption"
          color="error"
          role="alert"
          sx={{ whiteSpace: 'normal' }}
        >
          {error}
        </Typography>
      )}
    </>
  );
}

/** One verdict rollup for the round, every reviewer in its tooltip, and any blocking count. */
function ReviewsCell({ row }: { row: BoardRow }) {
  const rollup = reviewRollup(row.reviews);
  return (
    <Stack direction="row" spacing={0.5}>
      {rollup && (
        <Tooltip
          describeChild
          title={row.reviews.map((v) => (
            <div key={v.reviewer}>
              {v.reviewer}: {v.verdict ?? 'pending'}
            </div>
          ))}
        >
          {/* A link to the current round on the detail's Reviews tab (ticket 0007). */}
          <Chip
            component="a"
            href={jobHref(row.id, 'Reviews', row.round)}
            clickable
            label={rollup.label}
            color={rollup.color}
            variant={rollup.color === 'default' ? 'outlined' : 'filled'}
          />
        </Tooltip>
      )}
      {row.blocking !== null && row.blocking > 0 && (
        <Chip label={`${String(row.blocking)} blocking`} color="error" />
      )}
    </Stack>
  );
}

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

export type Sort = { id: string; dir: 'asc' | 'desc' } | null;

/** A URL `sort` value (`<columnId>:asc|desc`); null unless the column exists and is sortable. */
export function parseSort(v: string | null): Sort {
  const m = /^([a-z]+):(asc|desc)$/.exec(v ?? '');
  const id = m?.[1];
  const dir = m?.[2];
  if (!id || (dir !== 'asc' && dir !== 'desc')) return null;
  return COLUMNS.some((c) => c.id === id && c.sortValue) ? { id, dir } : null;
}

function sorted(rows: BoardRow[], sort: Sort): BoardRow[] {
  const key = COLUMNS.find((c) => c.id === sort?.id)?.sortValue;
  if (!sort || !key) return [...rows].sort(byAttention); // no sort chosen: what needs attention
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
  total,
  now,
  onChanged,
  sort = null,
  onSort,
  beforeOpen,
}: {
  rows: BoardRow[];
  /** Jobs before the Show, Repository, and Filter controls; tells "none yet" from "none match". */
  total: number;
  now: number;
  onChanged: () => void;
  /** The column sort; App session state, kept in the board URL. Null: attention order. */
  sort?: Sort;
  onSort?: (s: Sort) => void;
  /** Runs before a row opens its job, so a pending board URL write lands first. */
  beforeOpen?: () => void;
}) {
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const openJob = (id: string) => {
    beforeOpen?.();
    window.location.hash = jobHref(id);
  };
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [target, setTarget] = useState<BoardRow | null>(null);
  // After archive/unarchive the trigger row usually leaves the view; move focus somewhere stable.
  const [refocus, setRefocus] = useState(false);
  const columnsButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!refocus) return;
    columnsButton.current?.focus();
    setRefocus(false);
  }, [refocus]);
  const ordered = useMemo(() => sorted(rows, sort), [rows, sort]);
  const labels = useMemo(() => repoLabels(rows.map((r) => r.repo)), [rows]);

  if (total === 0) {
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
    try {
      window.localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable or full: the choice lasts for this page only.
    }
  };
  const columns = COLUMNS.filter((c) => !c.hideable || !hidden.includes(c.id));

  return (
    <>
      <Stack direction="row" sx={{ px: 1, pt: 0.5, justifyContent: 'flex-end' }}>
        <Button
          ref={columnsButton}
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
      {rows.length === 0 ? (
        <Typography sx={{ p: 3 }} color="text.secondary" role="status">
          No jobs match these filters.
        </Typography>
      ) : (
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
                      sx={narrow(c)}
                      sortDirection={active ? sort.dir : false}
                      aria-sort={
                        active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
                      }
                    >
                      {c.sortValue ? (
                        <Tooltip title={c.hint ?? ''} describeChild>
                          <TableSortLabel
                            active={active}
                            direction={active ? sort.dir : 'asc'}
                            onClick={() => {
                              onSort?.({
                                id: c.id,
                                dir: active && sort.dir === 'asc' ? 'desc' : 'asc',
                              });
                            }}
                          >
                            {c.label}
                          </TableSortLabel>
                        </Tooltip>
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
              {ordered.map((r) => (
                <TableRow
                  key={r.id}
                  hover
                  data-job-id={r.id}
                  tabIndex={0}
                  sx={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    if (fromRowBody(e) && !window.getSelection()?.toString()) openJob(r.id);
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                      e.preventDefault();
                      openJob(r.id);
                    }
                  }}
                >
                  {columns.map((c) => (
                    <TableCell key={c.id} align={c.align} sx={{ ...c.sx, ...narrow(c) }}>
                      {c.cell(r, now, labels.get(r.repo), onChanged)}
                    </TableCell>
                  ))}
                  <TableCell>
                    {(r.archivedAt !== null || finished(r)) && (
                      <Button
                        size="small"
                        variant="outlined"
                        aria-label={`${r.archivedAt !== null ? 'Unarchive' : 'Archive'} ${r.title} (${r.id})`}
                        onClick={() => {
                          setTarget(r);
                        }}
                      >
                        {r.archivedAt !== null ? 'Unarchive' : 'Archive'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {target && (
        <ArchiveDialog
          row={target}
          onClose={() => {
            setTarget(null);
          }}
          onDone={() => {
            setTarget(null);
            setRefocus(true);
            onChanged();
          }}
        />
      )}
    </>
  );
}

/**
 * Confirm an archive or unarchive from the board. Only finished jobs can be archived; finishing
 * releases a job, but a session may have claimed it again, so the board always takes it over
 * (`force`); the server decides and re-checks either way.
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
  const verb = archive ? 'Archive' : 'Unarchive';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postAction(row.id, { action: archive ? 'archive' : 'unarchive', force: true });
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
        {verb} {row.title} ({row.id})?
      </DialogTitle>
      {error && (
        <DialogContent>
          <Alert severity="error">{error}</Alert>
        </DialogContent>
      )}
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            void submit();
          }}
          disabled={busy}
          autoFocus
        >
          {verb}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
