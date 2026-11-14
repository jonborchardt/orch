import { Button, Chip, Snackbar, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';

import type { Blocker, Liveness, Resume } from '../../src/server/types.ts';
import { BLOCKER_LABEL, STATE } from './format.ts';

/** Execution state chip: glyph plus label, never colour alone. Same look on board and detail. */
export function StatusChip({ state }: { state: Liveness }) {
  const s = STATE[state];
  return (
    <Chip
      label={`${s.glyph} ${s.label}`}
      color={s.color}
      variant={s.variant}
      data-state={state}
      title={s.describe}
    />
  );
}

/** One compact line explaining why the job is not progressing. */
export function BlockerText({ blocker, compact }: { blocker: Blocker; compact?: boolean }) {
  const text = blocker.detail ? `${blocker.summary}: ${blocker.detail}` : blocker.summary;
  if (compact) {
    return (
      <Tooltip title={`${BLOCKER_LABEL[blocker.kind]} — ${text}`}>
        <Typography
          component="div"
          variant="caption"
          color="text.secondary"
          data-blocker={blocker.kind}
          sx={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {text}
        </Typography>
      </Tooltip>
    );
  }
  return (
    <Stack spacing={0.5} data-blocker={blocker.kind}>
      <Typography>
        <b>{BLOCKER_LABEL[blocker.kind]}.</b> {blocker.summary}
        {blocker.detail ? '' : '.'}
      </Typography>
      {blocker.detail ? (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          Recorded reason: {blocker.detail}
        </Typography>
      ) : (
        (blocker.kind === 'escalated' || blocker.kind === 'failed') && (
          <Typography variant="body2" color="text.secondary">
            No reason was recorded with the escalation; check the events and artifacts.
          </Typography>
        )
      )}
    </Stack>
  );
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

const RESUME_NOTE: Partial<Record<Liveness, string>> = {
  blocked:
    'The job is waiting for a human. Resuming without a recorded decision sends it back to the stage it was escalated from; record a decision with the controls first if one is needed.',
  stale:
    'The lease lapsed, so the previous session is presumed gone; resuming takes the job over and continues from saved state.',
  interrupted: 'Resuming takes the job over and continues from saved state.',
  failed: 'Resuming puts the failed stage back to pending and runs it again from saved state.',
  idle: 'No live session owns the job; resuming picks it up where it stopped.',
};

/** The full affordance for the detail view: command, where to run it, copy, open the checkout. */
export function ResumeBox({
  id,
  resume,
  cli,
  state,
  checkout,
  checkoutLink,
  worktree,
}: {
  id: string;
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
        <CopyResume id={id} command={command} checkout={checkout} />
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
