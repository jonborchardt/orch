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
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { DashboardAction } from '../../src/ops/actions.ts';
import type { ActionResponse, JobDetailView } from '../../src/server/types.ts';
import { ApiFailure, postAction } from './api.ts';

const LABEL: Record<DashboardAction, string> = {
  approve: 'Approve (return to stage)',
  'request-review': 'Request another review round',
  'request-rework': 'Request rework',
  'accept-policy': 'Accept the verification policy from the worktree',
  'accept-delivery': 'Accept delivery without a CI verdict (human close-out)',
  cancel: 'Cancel job',
  archive: 'Archive job (hide it from the default board views)',
  unarchive: 'Unarchive job',
  merge: 'Merge the PR',
  'refresh-pr': 'Refresh the PR state from GitHub',
};

const STAGES = ['spec', 'build', 'review', 'approve', 'pr', 'ci'] as const;

/**
 * Human controls. Every action goes through the API, which applies the same validated workflow
 * transitions as the CLI. None of them can wake a session: the response says to resume.
 */
export function Actions({ detail, onDone }: { detail: JobDetailView; onDone: () => void }) {
  const [open, setOpen] = useState<DashboardAction | null>(null);
  const [reason, setReason] = useState('');
  const [force, setForce] = useState(false);
  const [to, setTo] = useState<string>(detail.job.returnStage ?? 'build');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finished = detail.job.status === 'completed' || detail.job.status === 'cancelled';
  // The server lists what the workflow allows here; the client only decides prominence.
  const allowed = new Set(detail.actions);
  const kind = detail.blocker?.kind;
  // Approve is the primary action only at a genuine approval gate (the approver escalated).
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

  const start = (a: DashboardAction) => {
    setReason('');
    setForce(false);
    setError(null);
    setOpen(a);
  };

  // Archive, unarchive, and merge are a plain confirm: only finished jobs qualify, so the dashboard
  // always takes over the lease of any session that claimed it again instead of asking.
  const plain = open === 'archive' || open === 'unarchive' || open === 'merge';
  const verb = open === 'archive' ? 'Archive' : open === 'merge' ? 'Merge' : 'Unarchive';

  const send = async (body: Parameters<typeof postAction>[1]) => {
    setBusy(true);
    setError(null);
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
        {allowed.has('merge') && (
          <Button
            variant="contained"
            color="success"
            onClick={() => {
              start('merge');
            }}
          >
            Merge
          </Button>
        )}
        {allowed.has('refresh-pr') && (
          <Button variant="outlined" onClick={refresh} disabled={busy}>
            Refresh PR
          </Button>
        )}
        {allowed.has('approve') && (
          <Button
            variant={approvalGate ? 'contained' : 'outlined'}
            color={approvalGate ? 'success' : 'inherit'}
            onClick={() => {
              start('approve');
            }}
          >
            Approve
          </Button>
        )}
        {allowed.has('request-rework') && (
          <Button
            variant={reworkPrimary ? 'contained' : 'outlined'}
            onClick={() => {
              start('request-rework');
            }}
          >
            Request rework
          </Button>
        )}
        {allowed.has('request-review') && (
          <Button
            variant="outlined"
            onClick={() => {
              start('request-review');
            }}
          >
            Request review round
          </Button>
        )}
        {allowed.has('accept-policy') && (
          <Button
            variant="outlined"
            color="warning"
            onClick={() => {
              start('accept-policy');
            }}
          >
            Accept verification policy
          </Button>
        )}
        {closeOut && (
          <Button
            variant="outlined"
            color="warning"
            onClick={() => {
              start('accept-delivery');
            }}
          >
            Accept delivery
          </Button>
        )}
        {allowed.has('cancel') && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              start('cancel');
            }}
          >
            Cancel job
          </Button>
        )}
        {allowed.has('archive') && (
          <Button
            variant="outlined"
            onClick={() => {
              start('archive');
            }}
          >
            Archive
          </Button>
        )}
        {allowed.has('unarchive') && (
          <Button
            variant="outlined"
            onClick={() => {
              start('unarchive');
            }}
          >
            Unarchive
          </Button>
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
          {detail.blocker?.summary ?? 'see the status above'}). Approve only moves it back to a
          stage without fixing anything; use it only once you have decided the job may continue.
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
            : plain
              ? `${verb} this job?`
              : open
                ? LABEL[open]
                : ''}
        </DialogTitle>
        {plain ? (
          (open === 'merge' || error) && (
            <DialogContent>
              <Stack spacing={2}>
                {open === 'merge' && (
                  <Typography data-testid="merge-confirm">
                    Merge <b>{detail.job.prUrl}</b> at <code>{detail.ci.head?.slice(0, 7)}</code> as
                    a merge commit. GitHub is checked first; the merge is refused if the head moved.
                    The branch is not deleted.
                  </Typography>
                )}
                {error && <Alert severity="error">{error}</Alert>}
              </Stack>
            </DialogContent>
          )
        ) : (
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {open === 'approve' && (
                <TextField
                  select
                  label="Return to stage"
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
                  This completes the job without a passing CI verdict and records your reason as the
                  human close-out. It does not merge or mark the PR ready.
                </Alert>
              ) : (
                <Alert severity="warning" variant="outlined">
                  This records the decision and returns the job to a pending stage. It does not
                  start or wake any Claude session; resume the job from a session afterwards.
                </Alert>
              )}
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </DialogContent>
        )}
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
            color={open === 'cancel' ? 'error' : 'primary'}
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
