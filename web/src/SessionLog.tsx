import { Alert, Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import type {
  JobDetailView,
  SessionAgent,
  SessionEntry,
  SessionLogView,
  SubagentSummary,
} from '../../src/server/types.ts';
import { ApiFailure, fetchSessionLog } from './api.ts';
import { ago } from './format.ts';
import { When } from './Progress.tsx';
import { fonts } from './theme.ts';

/** Collapsed text shows its first line, cut here. */
const PREVIEW = 200;
/**
 * A subagent whose meta file says `finished: false` counts as running only while its transcript
 * changed this recently; after that it reads `not finished` (it may be inside one long tool call,
 * or it may have died).
 */
export const RUNNING_WINDOW_MS = 5 * 60_000;

const agentLabel = (a: SessionAgent | null) =>
  a ? `${a.type ?? 'agent'}: ${a.description ?? a.id}` : 'main';

/**
 * `finished`, `running` (a recent `finished: false`), `not finished` (a quiet `finished: false`),
 * or `status unknown`, only when `finished` is `null` (no meta file or no readable field).
 */
export function subagentState(s: SubagentSummary, now = Date.now()): string {
  if (s.finished === null) return 'status unknown';
  if (s.finished) return 'finished';
  return now - Date.parse(s.modifiedAt) < RUNNING_WINDOW_MS ? 'running' : 'not finished';
}

const UNKNOWN_WHY = ' (its meta file has no readable finished field)';

function kib(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Plain text, never Markdown or HTML; long text collapses to its first line. */
function Text({ entry }: { entry: SessionEntry }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const first = entry.text.split('\n', 1)[0] ?? '';
  const preview = first.length > PREVIEW ? `${first.slice(0, PREVIEW)}…` : first;
  const long = preview !== entry.text || entry.truncated;
  const action = open ? 'Show less' : 'Show more';
  return (
    <Box>
      <Typography
        id={id}
        variant="body2"
        component="div"
        sx={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontFamily: entry.kind === 'user' || entry.kind === 'assistant' ? undefined : fonts.mono,
        }}
      >
        {open || !long ? entry.text : preview}
        {open && entry.truncated && ' … (cut at the entry limit)'}
      </Typography>
      {long && (
        <Button
          size="small"
          aria-expanded={open}
          aria-controls={id}
          // Starts with the visible text, then says which entry it opens.
          aria-label={`${action}: ${entry.kind} from ${agentLabel(entry.agent)}, ${ago(entry.at)}`}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {action}
        </Button>
      )}
    </Box>
  );
}

/**
 * The Session tab: what the job's Claude Code session and its subagents did, newest first, read
 * by the server from the transcript tied to the job. Fetched again whenever the detail polls,
 * and only while the tab is shown (it is mounted only then).
 */
export function SessionLog({ detail }: { detail: JobDetailView }) {
  const id = detail.job.id;
  const [log, setLog] = useState<SessionLogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchSessionLog(id).then(
      (l) => {
        if (alive) {
          setLog(l);
          setError(null);
        }
      },
      (err: unknown) => {
        if (alive)
          setError(err instanceof ApiFailure ? `${err.type}: ${err.message}` : String(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [id, detail]);

  const earlier = detail.claudeSessions.slice(1);
  const earlierList = earlier.length > 0 && (
    <Box data-testid="session-earlier">
      <Typography variant="subtitle2">Earlier Claude Code sessions (not read)</Typography>
      {earlier.map((s) => (
        <Typography key={s.ref} variant="body2">
          Attached <When iso={s.attachedAt} />: <code>claude --resume {s.ref}</code>
        </Typography>
      ))}
    </Box>
  );

  if (!log) {
    return error ? (
      <Alert severity="error">{error}</Alert>
    ) : (
      <LinearProgress aria-label="Loading the session log" />
    );
  }
  if (!log.found) {
    // Nothing here asks the reader to run a command: attaching needs the owning session's token.
    return (
      <Stack spacing={1}>
        <Typography color="text.secondary" data-testid="session-log-empty">
          {log.reason}{' '}
          {log.ref === null ? (
            <>
              Nothing to do here: the session runs <code>{log.attach}</code> itself.
            </>
          ) : (
            <>
              The conversation itself opens in a terminal with{' '}
              <code>claude --resume {log.ref}</code>.
            </>
          )}
        </Typography>
        {earlierList}
      </Stack>
    );
  }
  const main = log.files.find((f) => f.source === 'main');
  // Stable across polls, so an expanded entry stays expanded as newer ones arrive above it.
  const seen = new Map<string, number>();
  const keyOf = (e: SessionEntry) => {
    const k = `${e.at}|${e.agent?.id ?? ''}|${e.kind}|${e.text.slice(0, 64)}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}#${String(n)}`;
  };
  // A non-empty file with nothing shown was refused, unreadable, or in a format not recognised.
  const read = log.files.some((f) => f.size > 0);
  return (
    <Stack spacing={1.5}>
      <Box role="status">
        {error && <Chip label={`Could not refresh the session log: ${error}`} color="warning" />}
      </Box>
      <Typography variant="body2" data-testid="session-log-header">
        Transcript <code>{log.ref}</code>
        {main && (
          <>
            , modified <When iso={main.modifiedAt} />, {kib(main.size)}
          </>
        )}
        {log.matches > 1 && ` (${String(log.matches)} copies found; the newest is shown)`}.
      </Typography>
      <Box data-testid="session-subagents">
        <Typography variant="subtitle2" id="session-subagents-title">
          Subagents
        </Typography>
        {log.subagents.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            None recorded.
          </Typography>
        ) : (
          <Box
            component="ul"
            aria-labelledby="session-subagents-title"
            sx={{ listStyle: 'none', p: 0, m: 0 }}
          >
            {log.subagents.map((s) => {
              const state = subagentState(s);
              return (
                <Typography component="li" key={s.id} variant="body2" data-agent-id={s.id}>
                  {agentLabel(s)} — {state}
                  {state === 'status unknown' && UNKNOWN_WHY}, last active{' '}
                  <When iso={s.modifiedAt} />
                </Typography>
              );
            })}
          </Box>
        )}
        {log.subagentsNotRead > 0 && (
          <Typography variant="body2" color="text.secondary">
            {log.subagentsNotRead} older subagent transcript(s) not read.
          </Typography>
        )}
      </Box>
      {log.entries.length > 0 ? (
        <Stack
          component="ol"
          spacing={1}
          sx={{ listStyle: 'none', p: 0, m: 0 }}
          aria-label="Session timeline"
        >
          {log.entries.map((e) => (
            <Box
              component="li"
              key={keyOf(e)}
              data-kind={e.kind}
              sx={{ '& + &': { borderTop: 1, borderColor: 'divider', pt: 1 } }}
            >
              <Stack
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: 'center', flexWrap: 'wrap' }}
              >
                <Typography variant="caption" color="text.secondary">
                  <When iso={e.at} />
                </Typography>
                <Chip size="small" variant="outlined" label={agentLabel(e.agent)} />
                <Chip
                  size="small"
                  label={e.kind}
                  color={e.kind === 'error' ? 'error' : 'default'}
                />
              </Stack>
              <Text entry={e} />
            </Box>
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary" data-testid="session-log-no-entries">
          {read
            ? 'The transcript has content, but none of its records could be shown: it may be ' +
              'unreadable or in a format this dashboard does not recognise.'
            : 'No activity is recorded in the transcript yet.'}
        </Typography>
      )}
      {log.truncated && (
        <Typography variant="body2" color="text.secondary" data-testid="session-log-truncated">
          Earlier activity not shown: these are the most recent {log.entries.length} entries within
          the read limits.
        </Typography>
      )}
      {earlierList}
    </Stack>
  );
}
