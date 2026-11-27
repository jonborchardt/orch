import {
  Box,
  Chip,
  Link,
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
import { ago, localTime } from './format.ts';
import { type DetailTab, type TabName, stepTab } from './tabs.ts';
import { textSize, weight } from './theme.ts';

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

type Challenge = NonNullable<Progress['specChallenge']>;
/** The spec challenge's verdict as a step state (for its glyph and colour) and in words. */
const CHALLENGE: Record<Challenge['verdict'], { state: StepState; words: string }> = {
  pending: { state: 'current', words: 'pending' },
  changes: { state: 'stopped', words: 'changes requested' },
  pass: { state: 'done', words: 'passed' },
};

/** The Spec step's text in the strip, with the spec challenge after it when there is one. */
function stripText(s: Progress['steps'][number], challenge: Progress['specChallenge']): string {
  if (s.id !== 'spec' || !challenge) return stepText(s);
  const after = challenge.revised ? ' after a revision' : '';
  return `${stepText(s)}, spec challenge ${CHALLENGE[challenge.verdict].words}${after}`;
}

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
          {STEP[s.state].glyph} {stripText(s, progress.specChallenge)}
        </div>
      ))}
    >
      <span
        role="img"
        tabIndex={0}
        aria-label={`Progress: ${progress.label}. ${progress.steps.map((s) => stripText(s, progress.specChallenge)).join(', ')}`}
        style={{ whiteSpace: 'nowrap', cursor: 'help', fontSize: textSize.progress }}
      >
        <span aria-hidden style={{ letterSpacing: '0.1em', marginRight: '0.4em' }}>
          {progress.steps.map((s) => (
            <span
              key={s.id}
              data-step={s.id}
              data-step-state={s.state}
              style={{
                color: color[s.state],
                fontWeight: s.state === 'done' ? weight.regular : weight.bold,
              }}
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

/** Relative time; the tooltip is the local date and time with zone, `datetime` the ISO value. */
export function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={localTime(iso)}>
      {ago(iso)}
    </time>
  );
}

/**
 * The detail's Progress section: every step with its state and known times, then the timeline.
 * With `onOpen`, an entry whose step maps to an available tab (`stepTab`) is a link to it.
 */
export function ProgressSection({
  progress,
  timeline,
  tabs = [],
  onOpen,
}: {
  progress: Progress;
  timeline: Timeline;
  tabs?: readonly DetailTab[];
  onOpen?: (tab: TabName) => void;
}) {
  const color = useStepColor();
  const challenge = progress.specChallenge;
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
              {s.id === 'spec' && challenge && (
                <Box component="ul" sx={{ m: 0, pl: 3, listStyle: 'none' }}>
                  <li
                    data-testid="spec-challenge"
                    data-step-state={CHALLENGE[challenge.verdict].state}
                  >
                    <Box
                      component="span"
                      aria-hidden
                      sx={{ color: color[CHALLENGE[challenge.verdict].state], mr: 0.5 }}
                    >
                      {STEP[CHALLENGE[challenge.verdict].state].glyph}
                    </Box>
                    Spec challenge: {CHALLENGE[challenge.verdict].words}
                    {challenge.revised && ' (spec revised)'}
                  </li>
                </Box>
              )}
            </li>
          );
        })}
      </Box>
      <Typography variant="subtitle2" component="h3">
        Timeline
      </Typography>
      {timeline.entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No stage has started yet.
        </Typography>
      ) : (
        <Table size="small" aria-label="Timeline">
          <TableBody>
            {timeline.entries.map((e, i) => {
              const tab = onOpen ? stepTab(tabs, e.step) : null;
              return (
                <TableRow key={i} data-kind={e.kind}>
                  <TableCell sx={{ whiteSpace: 'nowrap', width: '1%' }}>
                    <When iso={e.at} />
                  </TableCell>
                  <TableCell>
                    {tab && onOpen ? (
                      <Link
                        component="button"
                        type="button"
                        variant="body2"
                        aria-label={`Open ${tab} tab: ${e.label}`}
                        onClick={() => {
                          onOpen(tab);
                        }}
                        sx={{ textAlign: 'left' }}
                      >
                        {e.label}
                      </Link>
                    ) : (
                      e.label
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}
