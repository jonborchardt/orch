import { Alert, Chip, Link, Stack, Typography } from '@mui/material';

import type { CiView, JobDetailView } from '../../src/server/types.ts';
import { ago, type ChipColor, ciColor, httpsHref, sha7 } from './format.ts';
import { LogRef, PrText, commitRef } from './Links.tsx';

type PrPhase = JobDetailView['prPhase'];

/** One presentation per PR phase; the glyph and label carry the meaning, colour only repeats it. */
const PHASE: Record<PrPhase, { glyph: string; label: string; color: ChipColor; title: string }> = {
  'no-pr': { glyph: '○', label: 'no PR', color: 'default', title: 'No PR has been created yet.' },
  draft: {
    glyph: '◇',
    label: 'draft',
    color: 'default',
    title: 'Draft PR: CI has not passed for it yet.',
  },
  'ci-running': {
    glyph: '◌',
    label: 'CI running',
    color: 'info',
    title: 'Required checks are still running.',
  },
  'ci-failing': {
    glyph: '✕',
    label: 'CI failing',
    color: 'error',
    title: 'Required checks failed.',
  },
  'ready-to-merge': {
    glyph: '✓',
    label: 'ready to merge',
    color: 'success',
    title: 'Completed on a passing verdict and marked ready. GitHub is checked again on Merge.',
  },
  'ready-mark-failed': {
    glyph: '!',
    label: 'ready marking failed',
    color: 'warning',
    title: 'CI passed but the PR is still a draft: run gh pr ready, then Refresh PR.',
  },
  merged: { glyph: '⇥', label: 'merged', color: 'primary', title: 'GitHub reports the PR merged.' },
  closed: {
    glyph: '⊘',
    label: 'closed',
    color: 'default',
    title: 'GitHub reports the PR closed without merging.',
  },
};

/** Where the PR stands in delivery, as orch last recorded it. */
export function PrPhaseChip({
  phase,
  onClick,
  disabled,
}: {
  phase: PrPhase;
  /** Set only where Refresh PR is allowed: the chip becomes a button that runs it. */
  onClick?: () => void;
  disabled?: boolean;
}) {
  const p = PHASE[phase];
  return (
    <Chip
      label={
        <>
          <span aria-hidden="true">{p.glyph}</span> {p.label}
        </>
      }
      color={p.color}
      variant="outlined"
      size="small"
      data-phase={phase}
      title={onClick ? `${p.title} Click to refresh the PR state from GitHub.` : p.title}
      onClick={onClick}
      disabled={disabled}
    />
  );
}

/** The CI state as a chip plus one line, for the board and the detail header. */
export function CiChip({
  ci,
  compact,
  secondary,
}: {
  ci: CiView;
  compact?: boolean;
  /** Outlined: evidence beside a completed job's outcome, not a headline. */
  secondary?: boolean;
}) {
  const at = ci.head ? ` @${sha7(ci.head)}` : '';
  const label =
    ci.completion === 'human'
      ? 'human close-out'
      : ci.completion === 'merged'
        ? `merged before CI (was ${ci.status ?? 'not observed'})${at}`
        : `CI ${ci.status ?? 'not observed'}${at}`;
  const color = ci.completion === 'human' ? 'warning' : ciColor(ci.status);
  return (
    <Stack
      direction={compact ? 'row' : 'column'}
      spacing={0.5}
      sx={{ alignItems: compact ? 'center' : 'flex-start' }}
    >
      <Chip
        label={label}
        color={color}
        variant={secondary ? 'outlined' : 'filled'}
        data-ci={ci.status ?? 'unobserved'}
        data-completion={ci.completion ?? ''}
      />
      {ci.current === false && (
        <Typography variant="caption" color="warning.main">
          not current HEAD
        </Typography>
      )}
    </Stack>
  );
}

/** The PR tab's CI panel: the verdict with its commit, the failures, and what to do. */
export function CiPanel({ detail }: { detail: JobDetailView }) {
  const { ci, job } = detail;
  const pr = detail.links.pr;
  const commit = commitRef(detail);
  return (
    <Stack spacing={1} data-testid="ci-panel">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <CiChip ci={ci} compact />
        <Typography>
          <PrText text={ci.line} pr={pr} />
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {ci.checkedAt ? `Last observed ${ago(ci.checkedAt)}` : 'Never observed'}
        {ci.head ? (
          <>
            {' '}
            for PR head {commit(ci.head, ci.head.length)}
            {ci.current === true ? ' (current worktree HEAD)' : ''}
          </>
        ) : null}
        .{ci.reason ? ` GitHub: ${ci.reason}` : ''}
      </Typography>
      {ci.failures.length > 0 && (
        <ul style={{ margin: 0 }}>
          {ci.failures.map((f) => {
            const url = httpsHref(f.url);
            const log = f.log ? detail.links.logs[f.log] : undefined;
            return (
              <li key={f.name}>
                <b>{f.name}</b> {f.conclusion}
                {url ? (
                  <>
                    {' '}
                    <Link href={url} target="_blank" rel="noreferrer noopener">
                      GitHub log
                    </Link>
                  </>
                ) : null}
                {f.log && log ? (
                  <>
                    {' '}
                    · <LogRef path={f.log} href={log} label="Saved log " />
                  </>
                ) : f.log ? (
                  <>
                    {' '}
                    · saved <code>{f.log}</code> under the artifact directory
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Alert severity={ci.completion === 'human' ? 'warning' : 'info'} variant="outlined">
        <PrText text={ci.guidance} pr={pr} />
        {job.stage === 'completed' ? '' : ' A draft PR is not a passing build.'}
      </Alert>
    </Stack>
  );
}
