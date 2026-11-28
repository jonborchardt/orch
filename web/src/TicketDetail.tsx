/**
 * One ticket (`#/tickets/<id>`): its fields and Markdown body with one Edit form, the lifecycle
 * actions, its links, jobs, and history. Every write is one `orch ticket` action carrying the
 * revision it was based on; the server decides whether it is allowed.
 */
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormHelperText,
  IconButton,
  LinearProgress,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Fragment, type ReactNode, useCallback, useId, useState } from 'react';

import type {
  Area,
  BlockReason,
  BoardRow,
  TicketFinish,
  TicketStatus,
  TicketSummary,
  TicketView,
} from '../../src/server/types.ts';
import { Markdown } from './Markdown.tsx';
import { usePolled } from './Runs.tsx';
import { ApiFailure, errorText, fetchTicket, fetchTicketHistory, ticketAction } from './api.ts';
import { ago, httpsHref } from './format.ts';
import { EFFORTS, PRIORITIES, TYPES, ticketHref, ticketKey, ticketState } from './ticketState.ts';
import { fonts, weight } from './theme.ts';

/** A native select: compact, labelled, and the same control in every ticket form. */
export function Pick({
  label,
  value,
  onChange,
  options,
  all,
  width = 120,
  size,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly (string | { value: string; label: string })[];
  /** Label of the empty first option; omitted when a value is required. */
  all?: string;
  width?: number;
  size?: 'small';
}) {
  return (
    <TextField
      select
      size={size}
      label={label}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      sx={{ minWidth: width }}
    >
      {all !== undefined && <option value="">{all}</option>}
      {options.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        );
      })}
    </TextField>
  );
}

type TicketField = (typeof FIELDS)[number];

/**
 * The fields of the Create and Edit ticket forms. `lead` (Create's Repository) comes first in the
 * row of selects; `create` marks the new-ticket dialog's title and body.
 */
export function TicketFields({
  value,
  onChange,
  areas,
  efforts,
  lead,
  create = false,
}: {
  value: Record<TicketField, string>;
  onChange: (k: TicketField, v: string) => void;
  areas: readonly string[];
  efforts: readonly string[];
  lead?: ReactNode;
  create?: boolean;
}) {
  const pick = (k: TicketField) => (v: string) => {
    onChange(k, v);
  };
  return (
    <>
      <TextField
        label="Title"
        value={value.title}
        onChange={(e) => {
          onChange('title', e.target.value);
        }}
        required={create}
        autoFocus={create}
        fullWidth
      />
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 2 }}>
        {lead}
        <Pick
          label="Priority"
          value={value.priority}
          onChange={pick('priority')}
          options={PRIORITIES}
          width={90}
        />
        <Pick label="Type" value={value.type} onChange={pick('type')} options={TYPES} />
        <Pick label="Area" value={value.area} onChange={pick('area')} options={areas} />
        <Pick
          label="Effort (days)"
          value={value.effort}
          onChange={pick('effort')}
          options={efforts}
          width={110}
        />
      </Stack>
      <TextField
        label="Description (Markdown)"
        value={value.body}
        onChange={(e) => {
          onChange('body', e.target.value);
        }}
        multiline
        minRows={create ? 8 : 10}
        maxRows={create ? 20 : undefined}
        fullWidth
        helperText={
          create
            ? undefined
            : 'Checklist items are plain Markdown: - [ ] open, - [x] done. A merge does not close a ticket while one is unchecked.'
        }
        slotProps={{ htmlInput: { style: { fontFamily: fonts.mono } } }}
      />
    </>
  );
}

/** The server's reasons, each on its line, with the ticket or job it names as a link. */
export function Reasons({ reasons }: { reasons: readonly BlockReason[] }) {
  const linked = (detail: string, token: string, href: string): ReactNode => {
    const at = detail.indexOf(token);
    if (at < 0) return detail;
    return (
      <>
        {detail.slice(0, at)}
        <Link href={href}>{token}</Link>
        {detail.slice(at + token.length)}
      </>
    );
  };
  return (
    <>
      {reasons.map((r, i) => (
        <Box key={i}>
          {r.ticket !== undefined
            ? linked(r.detail, ticketKey(r.ticket), ticketHref(r.ticket))
            : r.job !== undefined
              ? linked(r.detail, r.job, `#/jobs/${r.job}`)
              : r.detail}
        </Box>
      ))}
    </>
  );
}

/**
 * The lifecycle buttons offered per status. Only a convenience: the server's status machine
 * answers every click, and its refusal is shown as it is.
 */
const LIFECYCLE: Record<TicketStatus, readonly Lifecycle[]> = {
  open: ['start', 'done', 'drop', 'duplicate'],
  'in-progress': ['done', 'drop', 'duplicate', 'reopen'],
  done: ['reopen'],
  dropped: ['reopen'],
  duplicate: ['reopen'],
};
type Lifecycle = 'start' | 'done' | 'drop' | 'duplicate' | 'reopen';
const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  start: 'Start',
  done: 'Done',
  drop: 'Drop',
  duplicate: 'Mark duplicate',
  reopen: 'Reopen',
};
const LIFECYCLE_HINT: Record<Lifecycle, string> = {
  start: 'Mark the ticket in progress by hand. This does not start a job.',
  done: 'Close the ticket as done.',
  drop: 'Close the ticket as not to be done.',
  duplicate: 'Close the ticket as a duplicate of another.',
  reopen: 'Put the ticket back in the open queue.',
};

const FIELDS = ['title', 'priority', 'type', 'area', 'effort', 'body'] as const;
type Draft = Record<TicketField, string> & {
  /** The ticket as it was when editing began: only fields that differ from it are sent. */
  base: TicketView;
  /** The revision the save is checked against. */
  revision: number;
};
const lf = (s: string) => s.replace(/\r\n/g, '\n');

/** One history row's payload as a short line; unknown shapes fall back to their JSON. */
function eventText(payload: Record<string, unknown>): string {
  const show = (v: unknown): string =>
    typeof v === 'string'
      ? v
      : typeof v === 'number'
        ? String(v)
        : Array.isArray(v)
          ? v.map(show).join(', ')
          : JSON.stringify(v);
  const isChange = (v: unknown): v is { from: unknown; to: unknown } =>
    typeof v === 'object' && v !== null && 'from' in v && 'to' in v;
  const parts: string[] = [];
  if ('from' in payload && 'to' in payload) {
    parts.push(`${show(payload['from'])} → ${show(payload['to'])}`);
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'from' || k === 'to' || v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    parts.push(isChange(v) ? `${k}: ${show(v.from)} → ${show(v.to)}` : `${k}: ${show(v)}`);
  }
  return parts.join(' · ');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box component="section" aria-label={title} sx={{ mt: 2 }}>
      <Typography variant="subtitle1" component="h2" sx={{ fontWeight: weight.semibold }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/**
 * The `?finish=` values: each opens one confirm of the "needs a person" section. Keep equal to
 * the `finish` keys of `FINISH_OPTIONS` in src/ops/tickets.ts, which writes the links.
 */
export const FINISH_OPTIONS = ['split', 'close', 'rework'] as const;
export type FinishOption = (typeof FINISH_OPTIONS)[number];

/** The buttons of that section: label, the confirm it opens, and whether "Hold for a person" starts ticked. */
const FINISH_BUTTONS: readonly (readonly [string, FinishOption, boolean])[] = [
  ['Move to a follow-up and close', 'split', false],
  ['Hold a follow-up for a person and close', 'split', true],
  ['They are done, close', 'close', false],
  ['Rework', 'rework', false],
];

/** Each confirm's title (given the ticket key) and the label of its confirming button. */
const FINISH_TEXT: Record<FinishOption, { title: (key: string) => string; confirm: string }> = {
  split: {
    title: (key) => `Move unticked boxes of ticket ${key} to a follow-up?`,
    confirm: 'Move and close',
  },
  close: {
    title: (key) => `Close ticket ${key} with every box ticked?`,
    confirm: 'Tick all and close',
  },
  rework: { title: (key) => `Rework ticket ${key}?`, confirm: 'Reopen for rework' },
};

/** What a merged ticket still needs: its unticked boxes, quoted, and the merged job's known gaps. */
export function Remaining({ finish }: { finish: TicketFinish }) {
  return (
    <>
      <Box component="ol" sx={{ my: 0.5, pl: 3 }} aria-label="Unticked boxes">
        {finish.remaining.map((item, i) => (
          <li key={i}>“{item}”</li>
        ))}
      </Box>
      {finish.knownGaps !== null && (
        <Box data-testid="known-gaps">
          <Typography sx={{ fontWeight: weight.semibold }}>
            Known gaps of {finish.jobId} (build.md)
          </Typography>
          <Markdown text={finish.knownGaps} />
        </Box>
      )}
    </>
  );
}

export function TicketDetail({
  id,
  finish = null,
  tickets,
  jobs,
  areas,
  refreshMs = 4000,
  onChanged,
}: {
  id: number;
  /**
   * `#/tickets/<id>?finish=<option>`: open that option's confirm on mount when the ticket has
   * something to finish. Opening posts nothing; only its Confirm does. The caller keys by it.
   */
  finish?: FinishOption | null;
  /** The list, for the titles of linked tickets. */
  tickets: readonly TicketSummary[];
  /** Each ticket's job from the board, for its liveness. */
  jobs: ReadonlyMap<number, BoardRow>;
  areas: readonly Area[];
  refreshMs?: number;
  /** A write happened: the list is stale. */
  onChanged: () => unknown;
}) {
  const fetcher = useCallback(
    () =>
      Promise.all([fetchTicket(id), fetchTicketHistory(id)]).then(([detail, history]) => ({
        detail,
        history,
      })),
    [id],
  );
  // The raw error, so a 404 still reads as "no such ticket".
  const { data, error: loadError, reload } = usePolled(fetcher, refreshMs);
  const detail = data?.detail ?? null;
  const history = data?.history ?? [];
  const [error, setError] = useState<string | null>(null);
  // Polls replace `detail` only; an open draft is its own state and is never touched by one.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<'drop' | 'duplicate' | null>(null);
  const [duplicateOf, setDuplicateOf] = useState('');
  const [finishing, setFinishing] = useState<FinishOption | null>(finish);
  // The follow-up as the split confirm has it; an empty field means "as this ticket".
  const [kept, setKept] = useState<readonly number[]>([]);
  const [hold, setHold] = useState(false);
  const [followUp, setFollowUp] = useState({ repo: '', area: '', priority: '' });
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const linkRowId = useId();

  const back = (
    <Link href="#/tickets" underline="hover">
      ← Tickets
    </Link>
  );
  if (!detail) {
    if (loadError === null) {
      return (
        <Box sx={{ p: 2 }}>
          <LinearProgress aria-label={`Loading ticket ${ticketKey(id)}`} />
        </Box>
      );
    }
    const missing = loadError instanceof ApiFailure && loadError.status === 404;
    return (
      <Alert severity={missing ? 'warning' : 'error'} role="alert" sx={{ m: 2 }}>
        {missing ? `There is no ticket ${ticketKey(id)}.` : errorText(loadError)} {back}
      </Alert>
    );
  }

  const t = detail.ticket;
  const key = ticketKey(t.id);
  const state = ticketState(t, jobs.get(t.id));
  const titleOf = (n: number) => tickets.find((x) => x.id === n)?.title;

  /** One action against the revision on screen; a refusal is shown and the ticket re-read. */
  const act = (body: { action: string } & Record<string, unknown>, revision = t.revision) => {
    setBusy(true);
    setError(null);
    return ticketAction(id, { ...body, revision })
      .then(
        () => true,
        (err: unknown) => {
          setError(
            err instanceof ApiFailure && err.type === 'OwnershipError'
              ? `Ticket ${key} was changed elsewhere, so nothing was saved (${err.message}) The current version is shown.`
              : errorText(err),
          );
          return false;
        },
      )
      .finally(() => {
        setBusy(false);
        void reload();
        void onChanged();
      });
  };

  const edit = () => {
    setError(null);
    setDraft({
      base: t,
      revision: t.revision,
      title: t.title,
      priority: t.priority,
      type: t.type,
      area: t.area,
      effort: String(t.effort),
      body: lf(t.body),
    });
  };
  const save = () => {
    if (!draft) return;
    const { base } = draft;
    const changed: Record<string, unknown> = {};
    for (const k of FIELDS) {
      if (k === 'body') {
        // A textarea speaks LF: an untouched CRLF body is not a change, and an edited one keeps CRLF.
        if (draft.body !== lf(base.body)) {
          changed['body'] = base.body.includes('\r\n')
            ? draft.body.replace(/\n/g, '\r\n')
            : draft.body;
        }
      } else if (draft[k] !== String(base[k])) {
        changed[k] = k === 'effort' ? Number(draft.effort) : draft[k];
      }
    }
    if (Object.keys(changed).length === 0) {
      setDraft(null);
      return;
    }
    setBusy(true);
    setError(null);
    ticketAction(id, { action: 'edit', ...changed, revision: draft.revision })
      .then(
        () => {
          setDraft(null);
          return reload();
        },
        async (err: unknown) => {
          if (!(err instanceof ApiFailure && err.type === 'OwnershipError')) {
            setError(errorText(err));
            return;
          }
          // Never overwrite silently: keep the draft, show what is there now, and let a second,
          // deliberate Save apply the user's own changes on top of it.
          const fresh = await reload();
          if (fresh) setDraft({ ...draft, revision: fresh.detail.ticket.revision });
          setError(
            `Ticket ${key} was changed elsewhere while you were editing, so nothing was saved. ` +
              'Your draft is kept. Compare it with the current ticket, then Save again to apply ' +
              'your changes, or Cancel to discard them.',
          );
        },
      )
      .finally(() => {
        setBusy(false);
        void onChanged();
      });
  };

  const left = detail.finish;
  const boxCount = left?.remaining.length ?? 0;
  const moved = (left?.remaining ?? []).flatMap((_, i) => (kept.includes(i + 1) ? [] : [i + 1]));
  const openFinish = (option: FinishOption, held = false) => {
    setHold(held);
    setFinishing(option);
  };
  const confirmFinish = () => {
    const option = finishing;
    setFinishing(null);
    if (option === 'split') {
      const over = Object.fromEntries(Object.entries(followUp).filter(([, v]) => v !== ''));
      void act({ action: 'split', boxes: moved, hold, ...over });
    } else if (option === 'close') void act({ action: 'done', tickAll: true });
    else if (option === 'rework') {
      void act({
        action: 'reopen',
        note: `rework: boxes left unticked after ${left?.jobId ?? 'the merge'}`,
      });
    }
  };

  const link = (kind: 'dep' | 'related', add: boolean, n: number | string) =>
    act({ action: `${kind}-${add ? 'add' : 'remove'}`, target: n });
  const chips = (ids: readonly number[], remove?: 'dep' | 'related') => {
    const removes = remove === 'dep' ? 'dependency on' : 'related ticket';
    return ids.length === 0 ? (
      <Typography component="span" color="text.secondary">
        none
      </Typography>
    ) : (
      ids.map((n) => (
        <Fragment key={n}>
          <Chip
            component="a"
            href={ticketHref(n)}
            clickable
            variant="outlined"
            label={`${ticketKey(n)} ${titleOf(n) ?? ''}`.trim()}
            sx={{ maxWidth: 320 }}
          />
          {remove && (
            // A sibling of the link, never inside it: a native button with its own name.
            <IconButton
              size="small"
              aria-label={`Remove ${removes} ${ticketKey(n)}`}
              disabled={busy}
              onClick={(e) => {
                const button = e.currentTarget;
                const row = button.parentElement;
                void link(remove, false, n).then((ok) => {
                  // The button is about to go with its link: focus stays in its row instead of
                  // falling to the page. A refused removal, or focus the user has moved, is left.
                  const at = document.activeElement;
                  if (ok && (at === button || at === document.body)) row?.focus();
                });
              }}
              sx={{ ml: -0.5 }}
            >
              <span aria-hidden>×</span>
            </IconButton>
          )}
        </Fragment>
      ))
    );
  };
  const linkRow = (label: string, body: ReactNode) => {
    const labelId = `${linkRowId}-${label.replace(/\s/g, '-')}`;
    return (
      // Focusable from code only: where focus lands when one of the row's links is removed. A
      // group named by its label, so that focus has something to announce.
      <Stack
        tabIndex={-1}
        role="group"
        aria-labelledby={labelId}
        direction="row"
        spacing={0.75}
        useFlexGap
        sx={{ alignItems: 'center', flexWrap: 'wrap', my: 0.5 }}
      >
        <Typography id={labelId} sx={{ minWidth: 90 }} color="text.secondary">
          {label}
        </Typography>
        {body}
      </Stack>
    );
  };

  return (
    <Box sx={{ p: 2, maxWidth: 1100, overflowWrap: 'anywhere' }}>
      <Box component="header" data-testid="ticket-header">
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
        >
          {back}
          <Typography variant="h6" component="h1" sx={{ minWidth: 0 }}>
            {t.title}
          </Typography>
          <Typography color="text.secondary">{key}</Typography>
          <Chip
            label={state.label}
            color={state.color}
            variant={state.variant}
            title={state.describe}
            data-ticket-state={state.label}
          />
          {loadError !== null && (
            <Chip label={`refresh failed: ${errorText(loadError)}`} color="warning" />
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          <span title={t.repoPath}>{t.repo}</span> · {t.status} · {t.priority} · {t.type} · {t.area}{' '}
          · {String(t.effort)} d ·{' '}
          <time dateTime={t.updatedAt} title={t.updatedAt}>
            updated {ago(t.updatedAt)}
          </time>
          {t.duplicateOf !== null && (
            <>
              {' · duplicate of '}
              <Link href={ticketHref(t.duplicateOf)}>{ticketKey(t.duplicateOf)}</Link>
            </>
          )}
        </Typography>
      </Box>

      {t.blockedBy.length > 0 && (
        <Alert severity="warning" role="note" sx={{ mt: 1 }} data-testid="ticket-blockers">
          <Reasons reasons={t.blockedBy} />
        </Alert>
      )}
      {error && (
        <Alert
          severity="error"
          role="alert"
          sx={{ mt: 1 }}
          onClose={() => {
            setError(null);
          }}
        >
          {error}
        </Alert>
      )}

      {left && !draft && (
        <Alert
          severity="warning"
          role="region"
          aria-label="Needs a person"
          sx={{ mt: 1 }}
          data-testid="ticket-finish"
        >
          <Typography sx={{ fontWeight: weight.semibold }}>
            Needs a person: <Link href={`#/jobs/${left.jobId}`}>{left.jobId}</Link> merged, but{' '}
            {String(boxCount)} box(es) are not ticked, so the ticket stays in progress.
          </Typography>
          <Remaining finish={left} />
          <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
            {FINISH_BUTTONS.map(([label, option, held]) => (
              <Button
                key={label}
                variant="outlined"
                disabled={busy}
                onClick={() => {
                  openFinish(option, held);
                }}
              >
                {label}
              </Button>
            ))}
          </Stack>
        </Alert>
      )}

      {draft ? (
        <Stack component="form" spacing={2} sx={{ mt: 2 }} aria-label={`Edit ticket ${key}`}>
          <TicketFields
            value={draft}
            onChange={(k, v) => {
              setDraft({ ...draft, [k]: v });
            }}
            areas={[...new Set([...areas.map((a) => a.name), draft.base.area])]}
            efforts={[...new Set([...EFFORTS.map(String), String(draft.base.effort)])]}
          />
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={save} disabled={busy || !draft.title.trim()}>
              Save
            </Button>
            <Button
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </Stack>
        </Stack>
      ) : (
        <>
          <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}>
            <Button variant="outlined" onClick={edit}>
              Edit
            </Button>
            {LIFECYCLE[t.status].map((a) => (
              <Button
                key={a}
                title={LIFECYCLE_HINT[a]}
                disabled={busy}
                color={a === 'drop' ? 'error' : 'primary'}
                onClick={() => {
                  if (a === 'drop' || a === 'duplicate') setConfirm(a);
                  else void act({ action: a });
                }}
              >
                {LIFECYCLE_LABEL[a]}
              </Button>
            ))}
          </Stack>
          <Section title="Description">
            {t.body.trim() ? (
              <Markdown text={t.body} />
            ) : (
              <Typography color="text.secondary">No description.</Typography>
            )}
          </Section>
        </>
      )}

      <Section title="Links">
        {linkRow('Depends on', chips(t.dependsOn, 'dep'))}
        {linkRow('Blocks', chips(detail.dependents))}
        {linkRow('Related', chips(t.related, 'related'))}
        <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center' }}>
          <TextField
            label="Ticket id"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
            }}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { inputMode: 'numeric' } }}
            sx={{ width: 110 }}
          />
          {(['dep', 'related'] as const).map((kind) => (
            <Button
              key={kind}
              disabled={busy || !target.trim()}
              onClick={() => {
                void link(kind, true, target.trim()).then((ok) => {
                  if (ok) setTarget('');
                });
              }}
            >
              {kind === 'dep' ? 'Add dependency' : 'Add related'}
            </Button>
          ))}
        </Stack>
      </Section>

      <Section title="Jobs">
        {detail.jobs.length === 0 ? (
          <Typography color="text.secondary">
            No job has worked on this ticket. <code>orch do {key}</code> runs it.
          </Typography>
        ) : (
          <Table size="small" aria-label="Jobs of this ticket">
            <TableHead>
              <TableRow>
                <TableCell>Job</TableCell>
                <TableCell>Title</TableCell>
                <TableCell>Stage</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>PR</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {detail.jobs.map((j) => {
                const pr = httpsHref(j.prUrl);
                return (
                  <TableRow key={j.id}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Link href={`#/jobs/${j.id}`}>{j.id}</Link>
                    </TableCell>
                    <TableCell>
                      {j.title}
                      {j.supersededBy && (
                        <>
                          {' (superseded by '}
                          <Link href={`#/jobs/${j.supersededBy}`}>{j.supersededBy}</Link>)
                        </>
                      )}
                    </TableCell>
                    <TableCell>{j.stage}</TableCell>
                    <TableCell>{j.status}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {pr ? (
                        <Link href={pr} target="_blank" rel="noreferrer noopener">
                          {j.prState ?? 'PR'}
                        </Link>
                      ) : (
                        (j.prState ?? '')
                      )}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <time dateTime={j.createdAt} title={j.createdAt}>
                        {ago(j.createdAt)}
                      </time>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      {detail.receipt && (
        <Section title="Merge receipt">
          <Markdown text={detail.receipt.markdown} />
        </Section>
      )}

      <Section title="History">
        <Box component="ol" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
          {history.map((e) => (
            <Box component="li" key={e.id} sx={{ py: 0.25 }}>
              <Typography component="span" variant="body2" color="text.secondary">
                <time dateTime={e.createdAt}>{e.createdAt.slice(0, 16).replace('T', ' ')}</time>
                {e.actor ? ` · ${e.actor}` : ''}
              </Typography>{' '}
              <strong>{e.type.replace(/^ticket\./, '')}</strong> {eventText(e.payload)}
            </Box>
          ))}
        </Box>
      </Section>

      <Dialog
        open={confirm !== null}
        onClose={() => {
          setConfirm(null);
        }}
        aria-labelledby="ticket-confirm-title"
      >
        <DialogTitle id="ticket-confirm-title">
          {confirm === 'drop' ? `Drop ticket ${key}?` : `Mark ticket ${key} a duplicate?`}
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: confirm === 'duplicate' ? 2 : 0 }}>
            {confirm === 'drop'
              ? 'It leaves the queue as not to be done. Tickets that depend on it stay blocked until that link is removed. Reopen brings it back.'
              : 'It leaves the queue and points at the ticket it repeats. Reopen brings it back.'}
          </Typography>
          {confirm === 'duplicate' && (
            <TextField
              label="Duplicate of (ticket id)"
              value={duplicateOf}
              onChange={(e) => {
                setDuplicateOf(e.target.value);
              }}
              autoFocus
              slotProps={{ inputLabel: { shrink: true } }}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirm(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color={confirm === 'drop' ? 'error' : 'primary'}
            disabled={busy || (confirm === 'duplicate' && !duplicateOf.trim())}
            onClick={() => {
              const body =
                confirm === 'drop'
                  ? { action: 'drop' }
                  : { action: 'duplicate', of: duplicateOf.trim() };
              setConfirm(null);
              setDuplicateOf('');
              void act(body);
            }}
          >
            {confirm === 'drop' ? 'Drop ticket' : 'Mark duplicate'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={finishing !== null && left !== null}
        onClose={() => {
          setFinishing(null);
        }}
        aria-labelledby="ticket-finish-title"
      >
        <DialogTitle id="ticket-finish-title">
          {finishing && FINISH_TEXT[finishing].title(key)}
        </DialogTitle>
        <DialogContent>
          {finishing === 'split' && left && (
            <Stack spacing={1.5}>
              <Typography>
                A new ticket “Follow-up of {key}: {t.title}” takes the selected boxes. Here they are
                ticked as “(moved to …)” and this ticket closes as done.
              </Typography>
              <Box role="group" aria-label="Boxes to move">
                {left.remaining.map((item, i) => (
                  <FormControlLabel
                    key={i}
                    sx={{ display: 'flex' }}
                    control={
                      <Checkbox
                        checked={!kept.includes(i + 1)}
                        onChange={(e) => {
                          setKept(
                            e.target.checked ? kept.filter((n) => n !== i + 1) : [...kept, i + 1],
                          );
                        }}
                      />
                    }
                    label={item}
                  />
                ))}
              </Box>
              <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', rowGap: 2 }}>
                <Pick
                  label="Repository"
                  value={followUp.repo}
                  onChange={(repo) => {
                    setFollowUp({ ...followUp, repo });
                  }}
                  all={`${t.repo} (this ticket's)`}
                  options={[...new Map(tickets.map((x) => [x.repoPath, x.repo]))]
                    .filter(([path]) => path !== t.repoPath)
                    .map(([value, label]) => ({ value, label }))}
                  width={200}
                />
                <Pick
                  label="Area"
                  value={followUp.area || t.area}
                  onChange={(area) => {
                    setFollowUp({ ...followUp, area: area === t.area ? '' : area });
                  }}
                  options={[...new Set([...areas.map((a) => a.name), t.area])]}
                />
                <Pick
                  label="Priority"
                  value={followUp.priority || t.priority}
                  onChange={(priority) => {
                    setFollowUp({ ...followUp, priority: priority === t.priority ? '' : priority });
                  }}
                  options={PRIORITIES}
                  width={90}
                />
              </Stack>
              <Box>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={hold}
                      onChange={(e) => {
                        setHold(e.target.checked);
                      }}
                    />
                  }
                  label="Hold for a person"
                />
                <FormHelperText>
                  Files the follow-up as a question. The controller never picks up a question, so it
                  waits until a person changes its type.
                </FormHelperText>
              </Box>
            </Stack>
          )}
          {finishing === 'close' && (
            <Typography>
              Ticks all {String(boxCount)} unticked box(es) and closes the ticket as done, in one
              write. Use this when the boxes are in fact done.
            </Typography>
          )}
          {finishing === 'rework' && (
            <Typography>
              Puts the ticket back in the open queue with its boxes unticked. Nothing starts now:
              the controller (orch start) or orch do {key} gives it a new job.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setFinishing(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={busy || (finishing === 'split' && moved.length === 0)}
            onClick={confirmFinish}
          >
            {finishing && FINISH_TEXT[finishing].confirm}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
