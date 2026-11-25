import {
  Alert,
  Box,
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
import { PrLink } from './Links.tsx';
import { resumeAt } from './Status.tsx';

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
  'fix-conflicts': 'Fix merge conflicts with the base',
  answer: 'Answer the question',
  'edit-spec': 'Edit spec.md',
};

const STAGES = ['spec', 'build', 'simplify', 'review', 'approve', 'pr', 'ci'] as const;

/**
 * The review round a rework, a review request, or a resume at review/simplify leads to. The human's
 * resume grants that round by raising `maxRounds` by one, so the maximum shown is the raised one.
 */
const nextRound = (job: JobDetailView['job']) =>
  `review round ${String(job.round + 1)} of ${String(job.maxRounds + 1)}`;

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
      return "Adopts factory.json at the worktree's HEAD as this job's verification policy. Earlier verification runs become stale; the next orch verify uses the accepted checks. A job waiting in needs-human goes back to the stage it was escalated from (except spec) as pending; no session starts.";
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
    case 'fix-conflicts': {
      const why =
        (d.conflicts?.files.length ?? 0) > 0
          ? 'The branch conflicts with its base'
          : 'GitHub reports the PR CONFLICTING';
      if (job.status === 'completed') {
        return `${why}. A finished job cannot be reopened, so this creates a re-land job and marks this one superseded; start it yourself with /factory <new id> in a new Claude Code session, and close this PR once the new one merges. No session is started.`;
      }
      const base = d.plan?.worktree?.baseRef ?? 'the base';
      const ci =
        job.stage === 'ci'
          ? ' Even a clean merge returns to build, since the new head needs verification, approval, and pr again; no CI repair is used.'
          : '';
      return `${why}. Merges ${base} into the branch: a conflicting merge is aborted and recorded, and the job returns to build as pending for the builder to resolve it.${ci} No session is started; resume the job from a Claude Code session.`;
    }
    case 'edit-spec':
      return 'Validates the text and replaces the registered spec.md, as orch job artifact add --replace does. The job stays in needs-human; pick the resume-to-spec choice afterwards so the spec challenger reviews the edit.';
    // An answer is described by the action its choice maps to.
    case 'refresh-pr':
    case 'answer':
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
  // The choice the open `answer` dialog is for; the dialog then reads as the action it maps to.
  const [choice, setChoice] = useState<number | null>(null);
  // The spec.md text the open `edit-spec` dialog edits.
  const [content, setContent] = useState('');
  const editing = open === 'edit-spec';
  // Only offered with the registered text to prefill; a spec above the detail's inline cap is
  // edited on disk instead (it would exceed the request body limit anyway).
  const specText = detail.contents['spec.md'];
  const picked = open === 'answer' && choice !== null ? detail.choices?.[choice] : undefined;
  const shown = picked ? picked.action : open;

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

  // The controls after Merge and Refresh PR, in order: [action, label, variant, colour].
  const buttons: [
    DashboardAction,
    string,
    'contained' | 'outlined',
    'success' | 'inherit' | 'warning' | 'error' | undefined,
  ][] = [
    [
      'approve',
      resumeAt(resumeStage),
      approvalGate ? 'contained' : 'outlined',
      approvalGate ? 'success' : 'inherit',
    ],
    ['edit-spec', 'Edit spec', 'outlined', undefined],
    ['fix-conflicts', 'Fix merge conflicts', 'outlined', 'warning'],
    ['request-rework', 'Request rework', reworkPrimary ? 'contained' : 'outlined', undefined],
    ['request-review', 'Request review round', 'outlined', undefined],
    ['accept-policy', 'Accept verification policy', 'outlined', 'warning'],
    ['accept-delivery', 'Accept delivery', 'outlined', 'warning'],
    ['cancel', 'Cancel job', 'outlined', 'error'],
    ['remove-worktree', 'Remove worktree', 'outlined', undefined],
    ['archive', 'Archive', 'outlined', undefined],
    ['unarchive', 'Unarchive', 'outlined', undefined],
  ];

  // describeChild puts the effect in aria-describedby, so the button keeps its name. A disabled
  // button gets no tooltip (MUI cannot attach one).
  const tip = (a: DashboardAction, button: ReactElement) => (
    <Tooltip key={a} describeChild title={busy ? '' : effect(a, detail, resumeStage)}>
      {button}
    </Tooltip>
  );

  const start = (a: DashboardAction) => {
    setReason('');
    setForce(false);
    setTo(resumeStage);
    setContent(specText ?? '');
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
    if (open === 'answer' && choice !== null) body.choice = choice;
    if (editing) body.content = content;
    await send(body);
  };

  const answer = (i: number) => {
    start('answer');
    setChoice(i);
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
      {detail.choices && detail.choices.length > 0 && (
        <Box component="section" aria-labelledby="choices-title" data-testid="choices">
          <Typography id="choices-title" variant="subtitle2">
            Choices
          </Typography>
          <Typography variant="body2" color="text.secondary">
            The job waits for a person; picking an answer continues it from there.
          </Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
            {detail.choices.map((c, i) => (
              <Button
                key={c.label}
                variant={i === 0 ? 'contained' : 'outlined'}
                disabled={busy || !c.available}
                onClick={() => {
                  answer(i);
                }}
              >
                {c.label}
              </Button>
            ))}
          </Stack>
          {detail.afterAction !== null && (
            <Typography
              variant="body2"
              color="text.secondary"
              data-testid="after-action"
              sx={{ mt: 1 }}
            >
              After an answer, {detail.afterAction}.
            </Typography>
          )}
        </Box>
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
        {buttons.map(
          ([a, label, variant, color]) =>
            allowed.has(a) &&
            (a !== 'edit-spec' || specText !== undefined) &&
            tip(
              a,
              <Button
                variant={variant}
                color={color}
                onClick={() => {
                  start(a);
                }}
              >
                {label}
              </Button>,
            ),
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
        maxWidth={editing ? 'md' : 'sm'}
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
                  : picked
                    ? picked.label
                    : open
                      ? LABEL[open]
                      : ''}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={plain ? undefined : { mt: 1 }}>
            {shown && (
              <Typography data-testid="action-effect">
                {effect(shown, detail, picked?.to ?? to)}
              </Typography>
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
                    PR <PrLink url={detail.job.prUrl ?? ''} pr={detail.links.pr} /> at{' '}
                    <code>{detail.ci.head?.slice(0, 7)}</code>; GitHub is checked first.
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
                {editing ? (
                  <TextField
                    label="spec.md"
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                    }}
                    multiline
                    minRows={12}
                    maxRows={30}
                    slotProps={{
                      htmlInput: { spellCheck: false, style: { fontFamily: 'monospace' } },
                    }}
                    autoFocus
                  />
                ) : open === 'fix-conflicts' ? (
                  (detail.conflicts?.files.length ?? 0) > 0 && (
                    <div>
                      <Typography id="fix-conflicts-label">Conflicting files:</Typography>
                      <Box
                        component="ul"
                        aria-labelledby="fix-conflicts-label"
                        data-testid="fix-conflicts-files"
                        sx={{ my: 0, maxHeight: 160, overflowY: 'auto', overflowWrap: 'anywhere' }}
                      >
                        {detail.conflicts?.files.map((f) => (
                          <li key={f}>
                            <code>{f}</code>
                          </li>
                        ))}
                      </Box>
                    </div>
                  )
                ) : (
                  <TextField
                    label={
                      open === 'accept-delivery'
                        ? 'Reason (required; recorded as the human close-out)'
                        : picked
                          ? 'Note (optional; recorded and passed to the next session)'
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
                )}
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
                {shown === 'accept-delivery' ? (
                  <Alert severity="warning" variant="outlined">
                    This completes the job without a passing CI verdict and records your reason as
                    the human close-out. It does not merge or mark the PR ready.
                  </Alert>
                ) : editing ? (
                  <Alert severity="info" variant="outlined">
                    Saving does not move the job or start any Claude session; answer the
                    resume-to-spec choice afterwards.
                  </Alert>
                ) : shown === 'cancel' ? (
                  <Alert severity="warning" variant="outlined">
                    This cannot be undone: a cancelled job is never resumed.
                  </Alert>
                ) : (
                  <Alert severity="warning" variant="outlined">
                    This records the decision
                    {open === 'accept-policy' || finished
                      ? ''
                      : ' and returns the job to a pending stage'}
                    . It does not start or wake any Claude session; resume the job from a session
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
            {plain || editing ? 'Cancel' : 'Close'}
          </Button>
          <Button
            variant="contained"
            color={shown === 'cancel' ? 'error' : open === 'merge' ? 'success' : 'primary'}
            onClick={() => {
              void submit();
            }}
            disabled={busy || (open === 'accept-delivery' && reason.trim() === '')}
            autoFocus={plain}
          >
            {plain ? verb : open === 'cancel' ? 'Cancel job' : editing ? 'Save' : 'Confirm'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
