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
  cancel: 'Cancel job',
};

const STAGES = ['spec', 'build', 'review', 'approve', 'pr'] as const;

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

  const submit = async () => {
    if (!open) return;
    setBusy(true);
    setError(null);
    try {
      const body: Parameters<typeof postAction>[1] = { action: open };
      if (reason.trim()) body.reason = reason.trim();
      if (force) body.force = true;
      if (open === 'approve') body.to = to;
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

  return (
    <Stack spacing={1}>
      {allowed.size === 0 && (
        <Typography variant="body2" color="text.secondary">
          No actions: the job is {detail.job.status}.
        </Typography>
      )}
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
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
      </Stack>
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
          if (!busy) setOpen(null);
        }}
        aria-labelledby="action-title"
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id="action-title">{open ? LABEL[open] : ''}</DialogTitle>
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
              label="Reason (recorded in the job's events)"
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
            <Alert severity="warning" variant="outlined">
              This records the decision and returns the job to a pending stage. It does not start or
              wake any Claude session; resume the job from a session afterwards.
            </Alert>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setOpen(null);
            }}
            disabled={busy}
          >
            Close
          </Button>
          <Button
            variant="contained"
            color={open === 'cancel' ? 'error' : 'primary'}
            onClick={() => {
              void submit();
            }}
            disabled={busy}
          >
            {open === 'cancel' ? 'Cancel job' : 'Confirm'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
