import { Alert, Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import type {
  JobDetailView,
  SessionAgent,
  SessionEntry,
  SessionLogView,
} from '../../src/server/types.ts';
import { ApiFailure, fetchSessionLog } from './api.ts';
import { ago } from './format.ts';

/** Collapsed text shows its first line, cut here. */
const PREVIEW = 200;

const agentLabel = (a: SessionAgent | null) =>
  a ? `${a.type ?? 'agent'}: ${a.description ?? a.id}` : 'main';

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {ago(iso)}
    </time>
  );
}

function kib(bytes: number): string {
  return bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Plain text, never Markdown or HTML; long text collapses to its first line. */
function Text({ entry }: { entry: SessionEntry }) {
  const [open, setOpen] = useState(false);
  const first = entry.text.split('\n', 1)[0] ?? '';
  const preview = first.length > PREVIEW ? `${first.slice(0, PREVIEW)}…` : first;
  const long = preview !== entry.text || entry.truncated;
  return (
    <Box>
      <Typography
        variant="body2"
        component="div"
        sx={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontFamily: entry.kind === 'user' || entry.kind === 'assistant' ? undefined : 'monospace',
        }}
      >
        {open || !long ? entry.text : preview}
        {open && entry.truncated && ' … (cut at the entry limit)'}
      </Typography>
      {long && (
        <Button
          size="small"
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          {open ? 'Show less' : 'Show more'}
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
    return (
      <Stack spacing={1}>
        <Typography color="text.secondary" data-testid="session-log-empty">
          {log.reason} The session that drives this job records itself by running{' '}
          <code>{log.attach}</code> inside Claude Code.
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
  return (
    <Stack spacing={1.5}>
      {error && <Chip label={`refresh failed: ${error}`} color="warning" />}
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
        <Typography variant="subtitle2">Subagents</Typography>
        {log.subagents.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            None recorded.
          </Typography>
        )}
        {log.subagents.map((s) => (
          <Typography key={s.id} variant="body2" data-agent-id={s.id}>
            {agentLabel(s)} — {s.finished === true ? 'finished' : 'running'}, modified{' '}
            <When iso={s.modifiedAt} />
          </Typography>
        ))}
        {log.subagentsNotRead > 0 && (
          <Typography variant="body2" color="text.secondary">
            {log.subagentsNotRead} older subagent transcript(s) not read.
          </Typography>
        )}
      </Box>
      <Stack
        component="ol"
        spacing={1}
        sx={{ listStyle: 'none', p: 0, m: 0 }}
        aria-label="Session timeline"
      >
        {log.entries.map((e) => (
          <Box component="li" key={keyOf(e)} data-kind={e.kind}>
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
              <Chip size="small" label={e.kind} color={e.kind === 'error' ? 'error' : 'default'} />
            </Stack>
            <Text entry={e} />
          </Box>
        ))}
        {log.entries.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No activity in the part of the transcript read.
          </Typography>
        )}
      </Stack>
      {log.truncated && (
        <Typography variant="body2" color="text.secondary" data-testid="session-log-truncated">
          Earlier activity not shown.
        </Typography>
      )}
      {earlierList}
    </Stack>
  );
}
