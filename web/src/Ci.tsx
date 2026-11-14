import { Alert, Chip, Link, Stack, Typography } from '@mui/material';

import type { CiView, JobDetailView } from '../../src/server/types.ts';
import { ago, ciColor, sha7 } from './format.ts';

/**
 * What the CI state means for the person reading it, from the server's structured fields only:
 * the rollup and the commit it was read for, whether that commit is still HEAD, the newest
 * reconciliation outcome, the repair budget, and how a finished job finished. Nothing here
 * decides anything; the controls come from the server's action list.
 */
export function ciSummary(d: Pick<JobDetailView, 'ci' | 'job'>): {
  line: string;
  guidance: string;
} {
  const { ci, job } = d;
  const at = `for ${sha7(ci.head)}`;
  const budget = `${String(ci.repairs)} of ${String(ci.maxRepairs)} repairs used`;
  if (ci.completion === 'human') {
    return {
      line: `Completed by human close-out; CI was ${ci.status ?? 'not observed'} ${at}.`,
      guidance:
        'A human accepted the delivery without a passing CI verdict (the reason is in the events). ' +
        'This is not an automated verification result.',
    };
  }
  if (ci.completion === 'legacy') {
    return {
      line: 'Completed before the ci stage existed; no CI verdict was recorded for a commit.',
      guidance: 'Check the PR on GitHub directly; nothing here vouches for its checks.',
    };
  }
  if (ci.completion === 'ci') {
    return {
      line: `Completed: required checks passed ${at}.`,
      guidance: 'Humans mark the PR ready and merge; the factory never does.',
    };
  }
  if (!job.prUrl) return { line: 'No PR yet.', guidance: 'CI is observed once a draft PR exists.' };
  if (ci.head === null || ci.status === null) {
    return {
      line: 'PR created; CI not yet observed.',
      guidance: `A session runs orch gh ci ${job.id} to read the checks for the PR head.`,
    };
  }
  const stale =
    ci.current === false ? ` That is not the current HEAD, so it no longer counts.` : '';
  if (job.prState === 'merged') {
    return {
      line: `PR merged outside the factory; CI was ${ci.status} ${at}.`,
      guidance: 'A human may accept the delivery to close the job out.',
    };
  }
  if (ci.outcome === 'closed') {
    return {
      line: `PR closed without merging; CI was ${ci.status} ${at}.`,
      guidance: 'Reopen the PR and Approve back to ci, or cancel the job.',
    };
  }
  if (ci.outcome === 'outdated') {
    return {
      line: `PR head moved outside the job; last verdict ${ci.status} ${at}.`,
      guidance: 'Approve back to pr to re-push the approved HEAD, or back to ci to re-read checks.',
    };
  }
  if (ci.status === 'none') {
    return {
      line: `GitHub reports no checks ${at}.`,
      guidance:
        'Add CI and Approve back to ci, or accept the delivery by hand (recorded as a human close-out).',
    };
  }
  if (ci.outcome === 'infrastructure') {
    return {
      line: `Required checks did not reach a verdict ${at}.${stale}`,
      guidance: 'Not a code defect: re-run the workflow or fix CI, then Approve back to ci.',
    };
  }
  if (ci.status === 'failing') {
    const exhausted = job.stage === 'needs-human' && ci.repairs >= ci.maxRepairs;
    if (exhausted) {
      return {
        line: `CI still failing ${at}; ${budget}.`,
        guidance:
          'The repair budget is spent. Request rework for one more attempt, fix it by hand on the ' +
          'branch and Approve back to ci, or cancel. Completion is not available while checks fail.',
      };
    }
    if (job.stage !== 'ci') {
      return {
        line: `CI failed ${at}; repair in progress (${budget}, stage ${job.stage}).`,
        guidance:
          'The builder repairs from the saved logs; the fix is reviewed and approved again.',
      };
    }
    return {
      line: `CI failing ${at}; ${budget}.${stale}`,
      guidance: 'orch gh ci acts on it next.',
    };
  }
  if (ci.status === 'pending') {
    return {
      line: `CI pending ${at}.${stale}`,
      guidance:
        'Waiting on GitHub; the session polls with orch gh ci. Completion is not available.',
    };
  }
  // passing
  return {
    line: `CI passing ${at}.${stale}`,
    guidance:
      ci.current === false
        ? `Run orch gh ci ${job.id} again for the current HEAD.`
        : 'The session completes the job; nothing here merges or marks the PR ready.',
  };
}

/** The CI state as a chip plus one line, for the board and the detail header. */
export function CiChip({ ci, compact }: { ci: CiView; compact?: boolean }) {
  const label =
    ci.completion === 'human'
      ? 'human close-out'
      : `CI ${ci.status ?? 'not observed'}${ci.head ? ` @${sha7(ci.head)}` : ''}`;
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
        data-ci={ci.status ?? 'unobserved'}
        data-completion={ci.completion ?? ''}
      />
      {(ci.repairs > 0 || ci.outcome === 'failing') && (
        <Typography variant="caption" color="text.secondary">
          repairs {ci.repairs}/{ci.maxRepairs}
        </Typography>
      )}
      {ci.current === false && (
        <Typography variant="caption" color="warning.main">
          not current HEAD
        </Typography>
      )}
    </Stack>
  );
}

/** The PR tab's CI panel: the verdict with its commit, the budget, the failures, and what to do. */
export function CiPanel({ detail }: { detail: JobDetailView }) {
  const { ci, job } = detail;
  const { line, guidance } = ciSummary(detail);
  return (
    <Stack spacing={1} data-testid="ci-panel">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <CiChip ci={ci} compact />
        <Typography>{line}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {ci.checkedAt ? `Last observed ${ago(ci.checkedAt)}` : 'Never observed'}
        {ci.head ? (
          <>
            {' '}
            for PR head <code>{ci.head}</code>
            {ci.current === true ? ' (current worktree HEAD)' : ''}
          </>
        ) : null}
        . Repairs used: {ci.repairs} of {ci.maxRepairs}.{ci.reason ? ` GitHub: ${ci.reason}` : ''}
      </Typography>
      {ci.failures.length > 0 && (
        <ul style={{ margin: 0 }}>
          {ci.failures.map((f) => (
            <li key={f.name}>
              <b>{f.name}</b> {f.conclusion}
              {f.url ? (
                <>
                  {' '}
                  <Link href={f.url} target="_blank" rel="noreferrer noopener">
                    GitHub log
                  </Link>
                </>
              ) : null}
              {f.log ? (
                <>
                  {' '}
                  · saved <code>{f.log}</code> under the artifact directory
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Alert severity={ci.completion === 'human' ? 'warning' : 'info'} variant="outlined">
        {guidance}
        {job.stage === 'completed' ? '' : ' A draft PR is not a passing build.'}
      </Alert>
    </Stack>
  );
}
