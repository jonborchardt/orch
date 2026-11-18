import {
  Box,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';

import type { Progress, StepState, Timeline } from '../../src/server/types.ts';

/** Glyph and words per step state, so colour is never the only cue. */
const STEP: Record<StepState, { glyph: string; words: string; color: string }> = {
  done: { glyph: '✓', words: 'done', color: 'success.main' },
  current: { glyph: '▶', words: 'current', color: 'primary.main' },
  stopped: { glyph: '■', words: 'stopped', color: 'error.main' },
  'not-started': { glyph: '○', words: 'not started', color: 'text.disabled' },
};

const stepText = (s: Progress['steps'][number]) => `${s.label}: ${STEP[s.state].words}`;

/**
 * The workflow at a glance: seven glyphs in order, then where the job is ("CI, needs human").
 * Focusable, with every step's state in its accessible name and its tooltip.
 */
export function ProgressStrip({ progress }: { progress: Progress }) {
  const theme = useTheme();
  const color: Record<StepState, string> = {
    done: theme.palette.success.main,
    current: theme.palette.primary.main,
    stopped: theme.palette.error.main,
    'not-started': theme.palette.text.disabled,
  };
  // Plain spans, not one styled component per glyph: the board renders a strip on every row.
  return (
    <Tooltip
      describeChild
      title={progress.steps.map((s) => (
        <div key={s.id}>
          {STEP[s.state].glyph} {stepText(s)}
        </div>
      ))}
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={`Progress: ${progress.label}. ${progress.steps.map(stepText).join(', ')}`}
        style={{ whiteSpace: 'nowrap', cursor: 'help', fontSize: '0.875rem' }}
      >
        <span aria-hidden style={{ letterSpacing: '0.1em', marginRight: '0.4em' }}>
          {progress.steps.map((s) => (
            <span
              key={s.id}
              data-step={s.id}
              data-step-state={s.state}
              style={{ color: color[s.state], fontWeight: s.state === 'done' ? 400 : 700 }}
            >
              {STEP[s.state].glyph}
            </span>
          ))}
        </span>
        <span aria-hidden>{progress.label}</span>
      </span>
    </Tooltip>
  );
}

/** `-` before the first review round, then `N / M`; the tooltip names the round and the maximum. */
export function RoundIndicator({
  round,
  maxRounds,
  chip,
}: {
  round: number;
  maxRounds: number;
  chip?: boolean;
}) {
  const text = round === 0 ? '-' : `${String(round)} / ${String(maxRounds)}`;
  const title =
    round === 0
      ? `No review round yet (at most ${String(maxRounds)})`
      : `Review round ${String(round)} of at most ${String(maxRounds)}`;
  return (
    <Tooltip title={title}>
      {chip ? (
        <Chip label={`Round ${text}`} tabIndex={0} aria-label={title} />
      ) : (
        <span tabIndex={0} aria-label={title}>
          {text}
        </span>
      )}
    </Tooltip>
  );
}

/** The detail's Progress section: every step with its state and known times, then the timeline. */
export function ProgressSection({
  progress,
  timeline,
}: {
  progress: Progress;
  timeline: Timeline;
}) {
  const last = (id: string, kind: string) =>
    timeline.entries.findLast((e) => e.step === id && e.kind === kind)?.at;
  return (
    <Stack spacing={1} data-testid="progress-section">
      <Typography variant="subtitle2" component="h2">
        Progress
      </Typography>
      <Box component="ol" aria-label="Workflow steps" sx={{ m: 0, pl: 3 }}>
        {progress.steps.map((s) => {
          const started = last(s.id, 'started');
          const completed = last(s.id, 'completed');
          const times =
            s.state === 'not-started'
              ? completed && `completed earlier at ${completed}`
              : s.state === 'done'
                ? completed && `completed ${completed}`
                : started && `started ${started}`;
          return (
            <li key={s.id} data-step={s.id} data-step-state={s.state}>
              <Box component="span" aria-hidden sx={{ color: STEP[s.state].color, mr: 0.5 }}>
                {STEP[s.state].glyph}
              </Box>
              {stepText(s)}
              {s.state === 'stopped' && ` (${progress.label})`}
              {times && (
                <Typography component="span" variant="body2" color="text.secondary">
                  {' '}
                  — {times}
                </Typography>
              )}
            </li>
          );
        })}
      </Box>
      <Typography variant="subtitle2" component="h3">
        Timeline
      </Typography>
      {timeline.truncated && (
        <Typography variant="body2" color="text.secondary">
          Earlier history not shown (only the newest events are loaded).
        </Typography>
      )}
      {timeline.entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No stage has started yet.
        </Typography>
      ) : (
        <Table size="small" aria-label="Timeline">
          <TableBody>
            {timeline.entries.map((e, i) => (
              <TableRow key={i} data-kind={e.kind}>
                <TableCell sx={{ whiteSpace: 'nowrap', width: '1%' }}>{e.at}</TableCell>
                <TableCell>{e.label}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}
