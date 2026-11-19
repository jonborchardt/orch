import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { type ReactElement, useState } from 'react';

import type { DashboardAction } from '../../src/ops/actions.ts';
import type { ActionResponse, JobDetailView } from '../../src/server/types.ts';
import { ApiFailure, postAction } from './api.ts';

const LABEL: Record<DashboardAction, string> = {
  approve: 'Resume at stage',
  'request-review': 'Request another review round',
  'request-rework': 'Request rework',
  'accept-policy': 'Accept the verification policy from the worktree',
  'accept-delivery': 'Accept delivery without a CI verdict (human close-out)',
  cancel: 'Cancel job',
  archive: 'Archive job (hide it from the default board views)',
  unarchive: 'Unarchive job',
  merge: 'Merge the PR',
  'refresh-pr': 'Refresh the PR state from GitHub',
  'remove-worktree': 'Remove the worktree (the branch is kept)',
};

const STAGES = ['spec', 'build', 'simplify', 'review', 'approve', 'pr', 'ci'] as const;

/** `approve` resumes the job at a stage; label it by that stage (`ci` and `pr` in capitals). */
const resumeAt = (stage: string) =>
  `Resume at ${stage === 'ci' || stage === 'pr' ? stage.toUpperCase() : stage}`;

/**
 * The review round a rework, a review request, or a resume at review/simplify leads to. `maxRounds`
 * limits rejected rounds, not round numbers, so "round 4 of 3" after a human rework is real.
 */
const nextRound = (job: JobDetailView['job']) =>
  `review round ${String(job.round + 1)} of ${String(job.maxRounds)}`;

/**
 * What a control does, as one sentence: its tooltip and the first line of its dialog. Each one
 * mirrors what `dashboardAction` in src/ops/actions.ts does and the `message` it returns; keep
 * them in step. `to` is the stage Resume sends the job to.
 */
function effect(a: DashboardAction, d: JobDetailView, to: string): string {
  const { job } = d;
  switch (a) {
    case 'approve':
      return (
        `Moves the job to ${to} as pending` +
        (to === 'review' || to === 'simplify' ? `, opening ${nextRound(job)}` : '') +
        '. It fixes nothing and starts no session; resume the job from a Claude Code session.'
      );
    case 'request-rework':
      return `The builder runs again from build; the next review is ${nextRound(job)}. The job waits in build as pending and no session starts.`;
    case 'request-review':
      return `The reviewers run again on the current build as ${nextRound(job)}. The job waits in review as pending and no session starts.`;
    case 'accept-policy':
      return "Adopts factory.json at the worktree's HEAD as this job's verification policy. Earlier verification runs become stale; the next orch verify uses the accepted checks.";
    case 'accept-delivery':
      return 'Completes the job without a CI verdict, with your reason recorded as the human close-out; nothing is merged or marked ready.';
    case 'cancel':
      return 'Ends the job as cancelled: it cannot be resumed. Its worktree and branch are kept.';
    case 'merge':
      return `Merges the PR at ${d.ci.head?.slice(0, 7) ?? '?'} as a merge commit; refused if the head moved. The branch is kept.`;
    case 'remove-worktree':
      return `Removes the worktree from disk; the branch ${job.branch ?? ''} is kept.`;
    case 'archive':
      return 'Hides the job from the board unless Show is set to archived.';
    case 'unarchive':
      return 'Puts the job back in the board views.';
    case 'refresh-pr':
      return '';
  }
}

/**
 * Human controls. Every action goes through the API, which applies the same validated workflow
 * transitions as the CLI. None of them can wake a session: the response says to resume.
 */
export function Actions({ detail, onDone }: { detail: JobDetailView; onDone: () => void }) {
  const [open, setOpen] = useState<DashboardAction | null>(null);
  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  // The detail view is not remounted per job or per poll, so the default stage is re-read here and
  // on every open: the button and Confirm never carry a stage over from another job.
  const resumeStage = detail.job.returnStage ?? 'build';
  const [to, setTo] = useState<string>(resumeStage);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finished = detail.job.status === 'completed' || detail.job.status === 'cancelled';
  // The server lists what the workflow allows here; the client only decides prominence.
  const allowed = new Set(detail.actions);
  const kind = detail.blocker?.kind;
  // Resume is the primary action only at a genuine approval gate (the approver escalated).
  const approvalGate = kind === 'decision';
  // Rework is primary only where the workflow itself would go back to build: reviewers still
  // requested changes at the last allowed round. Interruptions, verification failures, and
  // unclassified escalations get neutral controls; the right transition is a human call.
  const reworkPrimary = allowed.has('request-rework') && kind === 'findings';
  // The server offers accept-delivery only where the workflow allows a human close-out (a ci
  // escalation with no checks, or a PR merged by hand); it is never primary, and needs a reason.
  const closeOut = allowed.has('accept-delivery');
  const liveOwner =
    detail.job.ownerSession !== null &&
    detail.job.ownerSession !== 'dashboard' &&
    detail.job.leaseExpiresAt !== null &&
    Date.parse(detail.job.leaseExpiresAt) > Date.now();

  // describeChild puts the effect in aria-describedby, so the button keeps its name. A disabled
  // button gets no tooltip (MUI cannot attach one).
  const tip = (a: DashboardAction, button: ReactElement) => (
    <Tooltip describeChild title={busy ? '' : effect(a, detail, resumeStage)}>
      {button}
    </Tooltip>
  );

  const start = (a: DashboardAction) => {
    setReason('');
    setForce(false);
    setTo(resumeStage);
    setError(null);
    setOpen(a);
  };

  // Archive, unarchive, merge, and remove-worktree are a plain confirm: only finished jobs qualify,
  // so the dashboard always takes over the lease of any session that claimed it again instead of
  // asking.
  const removal = open === 'remove-worktree';
  const plain = open === 'archive' || open === 'unarchive' || open === 'merge' || removal;
  const verb =
    open === 'archive'
      ? 'Archive'
      : open === 'merge'
        ? 'Merge'
        : removal
          ? 'Remove worktree'
          : 'Unarchive';

  const send = async (body: Parameters<typeof postAction>[1]) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await postAction(detail.job.id, body);
      setResult(r);
      setOpen(null);
      onDone();
    } catch (err) {
      setError(err instanceof ApiFailure ? `${err.type}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!open) return;
    const body: Parameters<typeof postAction>[1] = { action: open };
    if (!plain && reason.trim()) body.reason = reason.trim();
    if (plain || force) body.force = true;
    if (open === 'approve') body.to = to;
    await send(body);
  };

  // Refresh PR only reads GitHub and records the PR state: no confirm. Finished jobs force, like Archive.
  const refresh = () => {
    void send(finished ? { action: 'refresh-pr', force: true } : { action: 'refresh-pr' });
  };

  return (
    <Stack spacing={1}>
      {allowed.size === 0 && (
        <Typography variant="body2" color="text.secondary">
          No actions: the job is {detail.job.status}.
        </Typography>
      )}
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {allowed.has('merge') &&
          tip(
            'merge',
            <Button
              variant="contained"
              color="success"
              onClick={() => {
                start('merge');
              }}
              disabled={busy}
            >
              Merge
            </Button>,
          )}
        {allowed.has('refresh-pr') && (
          <Button variant="outlined" onClick={refresh} disabled={busy}>
            Refresh PR
          </Button>
        )}
        {allowed.has('approve') &&
          tip(
            'approve',
            <Button
              variant={approvalGate ? 'contained' : 'outlined'}
              color={approvalGate ? 'success' : 'inherit'}
              onClick={() => {
                start('approve');
              }}
            >
              {resumeAt(resumeStage)}
            </Button>,
          )}
        {allowed.has('request-rework') &&
          tip(
            'request-rework',
            <Button
              variant={reworkPrimary ? 'contained' : 'outlined'}
              onClick={() => {
                start('request-rework');
              }}
            >
              Request rework
            </Button>,
          )}
        {allowed.has('request-review') &&
          tip(
            'request-review',
            <Button
              variant="outlined"
              onClick={() => {
                start('request-review');
              }}
            >
              Request review round
            </Button>,
          )}
        {allowed.has('accept-policy') &&
          tip(
            'accept-policy',
            <Button
              variant="outlined"
              color="warning"
              onClick={() => {
                start('accept-policy');
              }}
            >
              Accept verification policy
            </Button>,
          )}
        {closeOut &&
          tip(
            'accept-delivery',
            <Button
              variant="outlined"
              color="warning"
              onClick={() => {
                start('accept-delivery');
              }}
            >
              Accept delivery
            </Button>,
          )}
        {allowed.has('cancel') &&
          tip(
            'cancel',
            <Button
              variant="outlined"
              color="error"
              onClick={() => {
                start('cancel');
              }}
            >
              Cancel job
            </Button>,
          )}
        {allowed.has('remove-worktree') &&
          tip(
            'remove-worktree',
            <Button
              variant="outlined"
              onClick={() => {
                start('remove-worktree');
              }}
            >
              Remove worktree
            </Button>,
          )}
        {allowed.has('archive') &&
          tip(
            'archive',
            <Button
              variant="outlined"
              onClick={() => {
                start('archive');
              }}
            >
              Archive
            </Button>,
          )}
        {allowed.has('unarchive') &&
          tip(
            'unarchive',
            <Button
              variant="outlined"
              onClick={() => {
                start('unarchive');
              }}
            >
              Unarchive
            </Button>,
          )}
      </Stack>

      {open === null && error && <Alert severity="error">{error}</Alert>}
      {closeOut && (
        <Alert severity="warning" variant="outlined" data-testid="close-out-caution">
          Accept delivery completes the job by hand: CI is {detail.ci.status ?? 'not observed'} for{' '}
          {detail.ci.head?.slice(0, 7) ?? '?'}
          {detail.job.prState === 'merged' ? ' and the PR was merged outside the factory' : ''}. The
          job is then recorded as completed by human close-out, not by a passing CI verdict, with
          your reason. Nothing is merged or marked ready.
        </Alert>
      )}
      {allowed.has('approve') && !approvalGate && (
        <Alert severity="warning" variant="outlined" data-testid="approve-caution">
          This job is not waiting for an approval; it stopped because of a problem (
          {detail.blocker?.summary ?? 'see the status above'}). Resume only moves it back to a stage
          without fixing anything; use it only once you have decided the job may continue.
        </Alert>
      )}
      {allowed.has('accept-policy') && (
        <Alert severity="warning" variant="outlined">
          The worktree changes the verification policy (factory.json). Gates stay closed until a
          human accepts it here or it is reverted.
        </Alert>
      )}
      {liveOwner && !finished && (
        <Alert severity="info" variant="outlined">
          Session <b>{detail.job.ownerSession}</b> holds a live lease. Actions will be refused
          unless you confirm a forced takeover, which invalidates that session&apos;s token.
        </Alert>
      )}
      {result && (
        <Alert
          severity="success"
          onClose={() => {
            setResult(null);
          }}
          role="status"
        >
          {result.message}
          {result.resumeCommand && (
            <>
              {' '}
              <code>{result.resumeCommand}</code>
            </>
          )}
        </Alert>
      )}
      <Dialog
        open={open !== null}
        onClose={() => {
          if (busy) return;
          setOpen(null);
          setError(null);
        }}
        aria-labelledby="action-title"
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id="action-title">
          {open === 'merge'
            ? 'Merge this PR?'
            : removal
              ? 'Remove this worktree?'
              : plain
                ? `${verb} this job?`
                : open === 'approve'
                  ? resumeAt(to)
                  : open
                    ? LABEL[open]
                    : ''}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={plain ? undefined : { mt: 1 }}>
            {open && (
              <Typography data-testid="action-effect">{effect(open, detail, to)}</Typography>
            )}
            {plain ? (
              <>
                {removal && (
                  <Typography data-testid="remove-worktree-confirm">
                    Path <code>{detail.job.worktreePath}</code>, branch{' '}
                    <code>{detail.job.branch}</code>. Refused if the worktree has uncommitted
                    changes.
                  </Typography>
                )}
                {open === 'merge' && (
                  <Typography data-testid="merge-confirm">
                    PR <b>{detail.job.prUrl}</b> at <code>{detail.ci.head?.slice(0, 7)}</code>;
                    GitHub is checked first.
                  </Typography>
                )}
              </>
            ) : (
              <>
                {open === 'approve' && (
                  <TextField
                    select
                    label="Resume at stage"
                    value={to}
                    onChange={(e) => {
                      setTo(e.target.value);
                    }}
                  >
                    {STAGES.map((s) => (
                      <MenuItem key={s} value={s}>
                        {s}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <TextField
                  label={
                    open === 'accept-delivery'
                      ? 'Reason (required; recorded as the human close-out)'
                      : "Reason (recorded in the job's events)"
                  }
                  required={open === 'accept-delivery'}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                  multiline
                  minRows={2}
                  slotProps={{ htmlInput: { maxLength: 500 } }}
                  autoFocus
                />
                {liveOwner && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={force}
                        onChange={(e) => {
                          setForce(e.target.checked);
                        }}
                      />
                    }
                    label={`Take the job from session ${detail.job.ownerSession ?? ''} (its token stops working)`}
                  />
                )}
                {open === 'accept-delivery' ? (
                  <Alert severity="warning" variant="outlined">
                    This completes the job without a passing CI verdict and records your reason as
                    the human close-out. It does not merge or mark the PR ready.
                  </Alert>
                ) : open === 'cancel' ? (
                  <Alert severity="warning" variant="outlined">
                    This cannot be undone: a cancelled job is never resumed.
                  </Alert>
                ) : (
                  <Alert severity="warning" variant="outlined">
                    This records the decision
                    {open === 'accept-policy' ? '' : ' and returns the job to a pending stage'}. It
                    does not start or wake any Claude session; resume the job from a session
                    afterwards.
                  </Alert>
                )}
              </>
            )}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setOpen(null);
              setError(null);
            }}
            disabled={busy}
          >
            {plain ? 'Cancel' : 'Close'}
          </Button>
          <Button
            variant="contained"
            color={open === 'cancel' ? 'error' : open === 'merge' ? 'success' : 'primary'}
            onClick={() => {
              void submit();
            }}
            disabled={busy || (open === 'accept-delivery' && reason.trim() === '')}
            autoFocus={plain}
          >
            {plain ? verb : open === 'cancel' ? 'Cancel job' : 'Confirm'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
