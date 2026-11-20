import { Button, Chip, Link, Snackbar, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';

import type {
  Blocker,
  Flake,
  JobDetailView,
  Liveness,
  Outcome,
  Resume,
} from '../../src/server/types.ts';
import { BLOCKER_LABEL, STATE } from './format.ts';
import { PrText } from './Links.tsx';

/**
 * Execution state chip: glyph plus label, never colour alone. Same look on board and detail. A
 * completed job's label says how it ended (the server's outcome).
 */
export function StatusChip({
  state,
  outcome,
  tooltipExtra,
}: {
  state: Liveness;
  outcome?: Outcome | null;
  /** Detail header only: a second tooltip line (the owner and lease). */
  tooltipExtra?: string | null;
}) {
  const s = STATE[state];
  return (
    <Chip
      label={`${s.glyph} ${outcome?.label ?? s.label}`}
      color={s.color}
      variant={s.variant}
      data-state={state}
      data-outcome={outcome?.kind}
      title={tooltipExtra ? `${s.describe}\n${tooltipExtra}` : s.describe}
    />
  );
}

/** One compact line explaining why the job is not progressing. */
export function BlockerText({
  blocker,
  compact,
  ciLine,
  pr = null,
}: {
  blocker: Blocker;
  compact?: boolean;
  /** Detail only: a ci blocker's summary is the CI line. */
  ciLine?: string;
  /** Detail only: the PR URL to link inside the CI line (`links.pr`). */
  pr?: string | null;
}) {
  const text = blocker.detail ? `${blocker.summary}: ${blocker.detail}` : blocker.summary;
  if (compact) {
    return (
      <Tooltip title={`${BLOCKER_LABEL[blocker.kind]} — ${text}`}>
        <Typography
          component="div"
          variant="caption"
          color="text.secondary"
          data-blocker={blocker.kind}
          tabIndex={0}
          sx={{
            maxWidth: 240,
            whiteSpace: 'normal',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            cursor: 'help',
            textDecoration: 'underline dotted',
          }}
        >
          {text}
        </Typography>
      </Tooltip>
    );
  }
  // The detail's summary sentence: a ci blocker reads the CI line, which already names the head
  // and the repair budget; the recorded reason sits in the Details expander (BlockerNotes).
  const sentence =
    blocker.kind === 'ci' && ciLine ? (
      <PrText text={ciLine} pr={pr} />
    ) : (
      `${text}${blocker.detail ? '' : '.'}`
    );
  return (
    <Typography data-blocker={blocker.kind}>
      <b>{BLOCKER_LABEL[blocker.kind]}.</b> {sentence}
    </Typography>
  );
}

/** A likely flaky verification failure: a label naming the test, never a blocker. */
export function FlakeText({ flake, compact }: { flake: Flake; compact?: boolean }) {
  // text.secondary, not warning.main: small text needs 4.5:1; the prefix is the non-colour cue.
  // Same wording as `flakeLabel` in src/core/flake.ts (web imports only types from src/).
  const text =
    flake.sharedWith.length > 0
      ? `Likely machine-wide flaky test (also failing in ${flake.sharedWith.join(', ')}): ${flake.reason}`
      : `Likely flaky test: ${flake.reason}`;
  if (compact) {
    return (
      <Tooltip title={text}>
        <Typography
          component="div"
          variant="caption"
          color="text.secondary"
          data-flake={flake.rule}
          tabIndex={0}
          sx={{
            maxWidth: 240,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 2,
            cursor: 'help',
            textDecoration: 'underline dotted',
          }}
        >
          {text}
        </Typography>
      </Tooltip>
    );
  }
  return (
    <Typography component="div" variant="body2" color="text.secondary" data-flake={flake.rule}>
      {text}
    </Typography>
  );
}

/** What the detail's Details expander adds to the summary line about the blocker. */
export function BlockerNotes({ blocker }: { blocker: Blocker }) {
  if (blocker.kind === 'ci' && blocker.detail) {
    return (
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
        Recorded reason: {blocker.detail}
      </Typography>
    );
  }
  if (!blocker.detail && (blocker.kind === 'escalated' || blocker.kind === 'failed')) {
    return (
      <Typography variant="body2" color="text.secondary">
        No reason was recorded with the escalation; check the events and artifacts.
      </Typography>
    );
  }
  return null;
}

/** Same label as the Resume control in Actions.tsx (`ci` and `pr` in capitals). */
const resumeAt = (stage: string) =>
  `Resume at ${stage === 'ci' || stage === 'pr' ? stage.toUpperCase() : stage}`;

/** The detail's one "Next:" line, from fields the detail view already carries; null when cancelled. */
export function nextAction(d: JobDetailView): string | null {
  if (d.liveness === 'cancelled') return null;
  if (d.liveness === 'completed' || d.blocker?.kind === 'ci') return d.ci.guidance || null;
  switch (d.blocker?.kind) {
    case 'decision':
      return `Read the approver's decision below, then ${resumeAt(d.job.returnStage ?? 'build')} or Request rework.`;
    case 'findings':
      return 'Request rework to address the blocking findings, or cancel.';
    case 'verification':
      return 'Request rework to fix the failing check, or resume to run it again.';
    case 'escalated':
      return 'No control is recommended; read the events and artifacts, then choose.';
  }
  const holder =
    d.resume?.heldBy?.session ?? (d.liveness === 'running' ? d.job.ownerSession : null);
  if (holder) return `Continue from, or wait for, session ${holder}.`;
  return "Resume from a Claude Code session in the job's checkout.";
}

async function toClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the skill command. Copying changes nothing: the job is resumed only when a Claude Code
 * session opened in the checkout runs the command.
 */
export function CopyResume({
  id,
  command,
  checkout,
  compact,
}: {
  id: string;
  command: string;
  checkout: string;
  compact?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const copy = () => {
    void toClipboard(command).then((ok) => {
      setNote(
        ok
          ? `Copied ${command}. Paste it into a Claude Code session opened in ${checkout}.`
          : `Clipboard unavailable; copy by hand: ${command}`,
      );
    });
  };
  return (
    <>
      <Tooltip title={compact ? `${command} — run in a Claude Code session in ${checkout}` : ''}>
        <Button
          variant={compact ? 'text' : 'contained'}
          onClick={copy}
          aria-label={`Copy resume command for ${id}`}
          sx={compact ? { px: 0.5, minWidth: 0 } : undefined}
        >
          {compact ? 'Copy resume' : 'Copy resume command'}
        </Button>
      </Tooltip>
      <Snackbar
        open={note !== null}
        autoHideDuration={6000}
        onClose={() => {
          setNote(null);
        }}
        message={note}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      />
    </>
  );
}

export const RESUME_NOTE: Partial<Record<Liveness, string>> = {
  blocked:
    'The job is waiting for a human. Resuming without a recorded decision sends it back to the stage it was escalated from; record a decision with the controls first if one is needed.',
  stale:
    'The lease lapsed, so the previous session may no longer be working; resuming takes the job over and continues from saved state.',
  interrupted: 'Resuming takes the job over and continues from saved state.',
  failed: 'Resuming puts the failed stage back to pending and runs it again from saved state.',
  idle: 'No live session owns the job; resuming picks it up where it stopped.',
};

/**
 * The detail's resume particulars, inside the Details expander: the command, where to run it, and
 * the checkout link. The Copy resume command button sits outside, next to the summary.
 */
export function ResumeBox({
  resume,
  cli,
  state,
  checkout,
  checkoutLink,
  worktree,
}: {
  resume: Resume;
  /** The orch CLI form of the same resume, from the server. */
  cli: string;
  state: Liveness;
  checkout: string;
  checkoutLink: string;
  worktree: string | null;
}) {
  if (resume.command === null) {
    const held = resume.heldBy;
    return (
      <Stack spacing={0.5} data-testid="resume-unavailable">
        <Typography variant="subtitle2">Resume unavailable</Typography>
        <Typography variant="body2">
          Session <b>{held?.session}</b> holds a live lease
          {held?.leaseExpiresAt ? <> until {held.leaseExpiresAt}</> : ''}
          {state === 'running' ? ' and reports the job running' : ''}.{' '}
          <code>orch factory resume</code> would be refused until that lease lapses; continue from
          that session, or take the job over deliberately from a session of your own with{' '}
          <code>--force</code>. The dashboard never forces ownership on its own.
        </Typography>
      </Stack>
    );
  }
  const command = resume.command;
  return (
    <Stack spacing={1} data-testid="resume">
      <Typography variant="subtitle2">Resume</Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <code>{command}</code>
        <Button variant="outlined" href={checkoutLink} component="a">
          Open checkout in VS Code
        </Button>
      </Stack>
      <Typography variant="body2">
        Run it inside a Claude Code session opened in <code>{checkout}</code>, the checkout this job
        was started from
        {worktree ? (
          <>
            ; the job&apos;s worktree is <code>{worktree}</code>
          </>
        ) : (
          ''
        )}
        . Copying does not resume anything or change the job.
      </Typography>
      {RESUME_NOTE[state] && (
        <Typography variant="body2" color="text.secondary">
          {RESUME_NOTE[state]}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        Equivalent CLI: <code>{cli}</code>.
      </Typography>
    </Stack>
  );
}

/** Links between a job and the job that replaced it, or the jobs it replaced. */
export function Supersession({
  supersededBy,
  supersedes,
}: {
  supersededBy: string | null;
  supersedes: string[];
}) {
  if (!supersededBy && supersedes.length === 0) return null;
  return (
    <Typography component="div" variant="caption" color="text.secondary">
      {supersededBy && (
        <>
          superseded by <Link href={`#/jobs/${supersededBy}`}>{supersededBy}</Link>
        </>
      )}
      {supersededBy && supersedes.length > 0 && ' · '}
      {supersedes.length > 0 && (
        <>
          replaces{' '}
          {supersedes.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <Link href={`#/jobs/${id}`}>{id}</Link>
            </span>
          ))}
        </>
      )}
    </Typography>
  );
}
