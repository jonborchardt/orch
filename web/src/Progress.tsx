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
import { ago } from './format.ts';

/** Glyph and words per step state, so colour is never the only cue. */
const STEP: Record<StepState, { glyph: string; words: string }> = {
  done: { glyph: '✓', words: 'done' },
  current: { glyph: '▶', words: 'current' },
  stopped: { glyph: '■', words: 'stopped' },
  'not-started': { glyph: '○', words: 'not started' },
};

/** Step colours as CSS variables that follow the active light or dark scheme. */
function useStepColor(): Record<StepState, string> {
  // `theme.palette` is the light scheme only; `theme.vars` holds the scheme-following variables.
  const theme = useTheme();
  const palette = (theme.vars ?? theme).palette;
  return {
    done: palette.success.main,
    current: palette.primary.main,
    stopped: palette.error.main,
    'not-started': palette.text.secondary,
  };
}

/** Visually hidden, still read by assistive technology. */
const HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

const stepText = (s: Progress['steps'][number]) => `${s.label}: ${STEP[s.state].words}`;

/**
 * The workflow at a glance: eight glyphs in order, then where the job is ("CI, needs human").
 * Focusable, with every step's state in its accessible name and its tooltip.
 */
export function ProgressStrip({ progress }: { progress: Progress }) {
  const color = useStepColor();
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
  const count = `${String(round)} / ${String(maxRounds)}`;
  const title =
    round === 0
      ? `No review round yet (at most ${String(maxRounds)})`
      : `Review round ${String(round)} of at most ${String(maxRounds)}`;
  // The words are hidden text, not aria-label (prohibited on a generic span or a plain chip).
  return (
    <Tooltip title={title} describeChild>
      {chip ? (
        <Chip
          tabIndex={0}
          data-testid="round"
          label={
            <>
              {round === 0 ? 'Round: none' : `Round ${count}`}
              <span style={HIDDEN}>. {title}</span>
            </>
          }
        />
      ) : (
        <span tabIndex={0} data-testid="round">
          <span aria-hidden>{round === 0 ? '-' : count}</span>
          <span style={HIDDEN}>{title}</span>
        </span>
      )}
    </Tooltip>
  );
}

/** Relative time like the rest of the dashboard, with the exact timestamp kept in the markup. */
export function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={iso}>
      {ago(iso)}
    </time>
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
  const color = useStepColor();
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
          const [verb, iso] =
            s.state === 'not-started'
              ? ['completed earlier', completed]
              : s.state === 'done'
                ? ['completed', completed]
                : ['started', started];
          return (
            <li key={s.id} data-step={s.id} data-step-state={s.state}>
              <Box component="span" aria-hidden sx={{ color: color[s.state], mr: 0.5 }}>
                {STEP[s.state].glyph}
              </Box>
              {stepText(s)}
              {s.state === 'stopped' && ` (${progress.label})`}
              {iso && (
                <Typography component="span" variant="body2" color="text.secondary">
                  {' '}
                  — {verb} <When iso={iso} />
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
                <TableCell sx={{ whiteSpace: 'nowrap', width: '1%' }}>
                  <When iso={e.at} />
                </TableCell>
                <TableCell>{e.label}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}
