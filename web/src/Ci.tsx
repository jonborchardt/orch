import { Alert, Chip, Link, Stack, Typography } from '@mui/material';

import type { CiView, JobDetailView } from '../../src/server/types.ts';
import { ago, ciColor, sha7 } from './format.ts';

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
  return (
    <Stack spacing={1} data-testid="ci-panel">
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <CiChip ci={ci} compact />
        <Typography>{ci.line}</Typography>
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
        {ci.guidance}
        {job.stage === 'completed' ? '' : ' A draft PR is not a passing build.'}
      </Alert>
    </Stack>
  );
}
