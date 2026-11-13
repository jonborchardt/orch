import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Link,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { JobDetailView } from '../../src/server/types.ts';
import { Actions } from './Actions.tsx';
import { Markdown } from './Markdown.tsx';
import { ApiFailure, fetchDetail } from './api.ts';
import { LIVENESS_COLOR, LIVENESS_LABEL, ago, ciColor, verdictColor } from './format.ts';

const TABS = [
  'Overview',
  'Spec',
  'Build',
  'Reviews',
  'Findings',
  'Decision',
  'Artifacts',
  'Events',
  'Git',
  'Verification',
  'PR',
] as const;
type TabName = (typeof TABS)[number];

export function JobDetail({ id, refreshMs = 4000 }: { id: string; refreshMs?: number }) {
  const [detail, setDetail] = useState<JobDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabName>('Overview');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchDetail(id).then(
        (d) => {
          if (alive) {
            setDetail(d);
            setError(null);
          }
        },
        (err: unknown) => {
          if (alive)
            setError(err instanceof ApiFailure ? `${err.type}: ${err.message}` : String(err));
        },
      );
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, refreshMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, refreshMs, tick]);

  if (error && !detail) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error} <Link href="#/">Back to the board</Link>
      </Alert>
    );
  }
  if (!detail) return <Typography sx={{ p: 2 }}>Loading {id}…</Typography>;
  const { job } = detail;
  const latestRound = detail.rounds.at(-1);
  const content = (path: string | null | undefined) =>
    path && detail.contents[path] !== undefined ? (
      <Markdown text={detail.contents[path] ?? ''} />
    ) : (
      <Typography color="text.secondary">Not available{path ? ` (${path})` : ''}.</Typography>
    );

  return (
    <Box sx={{ p: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
      >
        <Link href="#/" underline="hover">
          ← Jobs
        </Link>
        <Typography variant="h6" component="h1">
          {job.title}
        </Typography>
        <Typography color="text.secondary">{job.id}</Typography>
        <Chip label={job.stage} variant="outlined" />
        <Chip label={LIVENESS_LABEL[detail.liveness]} color={LIVENESS_COLOR[detail.liveness]} />
        <Chip label={`round ${String(job.round)}/${String(job.maxRounds)}`} />
        {error && <Chip label={`refresh failed: ${error}`} color="warning" />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {job.repo} · base <code>{job.baseBranch}</code> · branch <code>{job.branch ?? '—'}</code> ·
        owner {job.ownerSession ?? 'none'}
        {job.leaseExpiresAt
          ? ` (lease ${Date.parse(job.leaseExpiresAt) > Date.now() ? 'until' : 'lapsed'} ${job.leaseExpiresAt})`
          : ''}{' '}
        · updated {ago(job.updatedAt)}
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
        {detail.links.vscode && (
          <Button variant="outlined" href={detail.links.vscode} component="a">
            Open worktree in VS Code
          </Button>
        )}
        {detail.links.pr && (
          <Button
            variant="outlined"
            href={detail.links.pr}
            component="a"
            target="_blank"
            rel="noreferrer noopener"
          >
            Open PR on GitHub
          </Button>
        )}
        <Button
          variant="text"
          onClick={() => {
            setTick((t) => t + 1);
          }}
        >
          Refresh
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }}>
        <Typography variant="subtitle2">Controls</Typography>
        <Actions
          detail={detail}
          onDone={() => {
            setTick((t) => t + 1);
          }}
        />
      </Paper>

      <Tabs
        value={tab}
        onChange={(_e, v: TabName) => {
          setTab(v);
        }}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mt: 2, borderBottom: 1, borderColor: 'divider' }}
        aria-label="Job sections"
      >
        {TABS.map((t) => (
          <Tab key={t} label={t} value={t} id={`tab-${t}`} aria-controls={`panel-${t}`} />
        ))}
      </Tabs>
      <Box role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} sx={{ pt: 2 }}>
        {tab === 'Overview' && (
          <Stack spacing={1}>
            {detail.plan ? (
              <>
                <Typography>
                  <b>Next step:</b> {detail.plan.step} — {detail.plan.reason}
                </Typography>
                {detail.plan.agents.length > 0 && (
                  <Typography variant="body2">
                    Agents: {detail.plan.agents.map((a) => `${a.agent} (${a.model})`).join(', ')}
                  </Typography>
                )}
                {detail.plan.blockedReason && (
                  <Alert severity="warning">Blocked: {detail.plan.blockedReason}</Alert>
                )}
              </>
            ) : (
              <Alert severity="warning">Plan unavailable: {detail.planError}</Alert>
            )}
            <Typography variant="body2">
              Resume from a session: <code>{detail.resumeCommand}</code>
            </Typography>
            {job.description && (
              <>
                <Divider />
                <Typography variant="subtitle2">Request</Typography>
                <Typography sx={{ whiteSpace: 'pre-wrap' }}>{job.description}</Typography>
              </>
            )}
            {detail.plan && detail.plan.artifacts.some((a) => !a.ok) && (
              <Alert severity="error">
                Artifact problems:{' '}
                {detail.plan.artifacts
                  .filter((a) => !a.ok)
                  .map((a) => `${a.path} (${a.problem ?? '?'})`)
                  .join('; ')}
              </Alert>
            )}
          </Stack>
        )}
        {tab === 'Spec' && content('spec.md')}
        {tab === 'Build' && content('build.md')}
        {tab === 'Reviews' &&
          (detail.rounds.length === 0 ? (
            <Typography color="text.secondary">No review rounds yet.</Typography>
          ) : (
            detail.rounds.map((r) => (
              <Box key={r.round} sx={{ mb: 3 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Round {r.round}
                  {r.blocking !== null && (
                    <Chip
                      sx={{ ml: 1 }}
                      label={`blocking ${String(r.blocking)}`}
                      color={r.blocking > 0 ? 'error' : 'success'}
                    />
                  )}
                </Typography>
                {r.reviews.length === 0 && (
                  <Typography color="text.secondary">No reviewers recorded.</Typography>
                )}
                {r.reviews.map((rv) => (
                  <Paper key={rv.id} variant="outlined" sx={{ p: 1.5, my: 1 }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Typography sx={{ fontWeight: 600 }}>{rv.reviewer}</Typography>
                      <Chip label={rv.verdict ?? 'pending'} color={verdictColor(rv.verdict)} />
                      {rv.summary && <Typography variant="body2">{rv.summary}</Typography>}
                    </Stack>
                    {rv.path && <Box sx={{ mt: 1 }}>{content(rv.path)}</Box>}
                  </Paper>
                ))}
              </Box>
            ))
          ))}
        {tab === 'Findings' &&
          (latestRound?.consolidated ? (
            detail.rounds
              .filter((r) => r.consolidated)
              .reverse()
              .map((r) => (
                <Box key={r.round} sx={{ mb: 3 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    Round {r.round} consolidated findings
                  </Typography>
                  {content(r.consolidated)}
                </Box>
              ))
          ) : (
            <Typography color="text.secondary">No consolidated findings yet.</Typography>
          ))}
        {tab === 'Decision' && content('decision.md')}
        {tab === 'Verification' && <Verification detail={detail} />}
        {tab === 'Artifacts' && (
          <Table size="small" aria-label="Artifacts">
            <TableHead>
              <TableRow>
                <TableCell>Path</TableCell>
                <TableCell>Stage</TableCell>
                <TableCell align="right">Bytes</TableCell>
                <TableCell>Marker</TableCell>
                <TableCell>SHA-256</TableCell>
                <TableCell>Registered</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {detail.artifacts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link
                      href={`/api/jobs/${job.id}/artifacts/${a.path}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {a.path}
                    </Link>
                  </TableCell>
                  <TableCell>{a.stage}</TableCell>
                  <TableCell align="right">{a.bytes}</TableCell>
                  <TableCell>{a.marker ?? ''}</TableCell>
                  <TableCell>
                    <code>{a.sha256?.slice(0, 12) ?? ''}</code>
                  </TableCell>
                  <TableCell>{ago(a.createdAt)}</TableCell>
                </TableRow>
              ))}
              {detail.artifacts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>No artifacts registered.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        {tab === 'Events' && (
          <Table size="small" aria-label="Events">
            <TableHead>
              <TableRow>
                <TableCell>Time</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Actor</TableCell>
                <TableCell>Payload</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {[...detail.events].reverse().map((e) => (
                <TableRow key={e.id}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {e.createdAt.replace('T', ' ').slice(0, 19)}
                  </TableCell>
                  <TableCell>{e.type}</TableCell>
                  <TableCell>{e.actor ?? ''}</TableCell>
                  <TableCell>
                    <code style={{ fontSize: 12 }}>{JSON.stringify(e.payload)}</code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {tab === 'Git' &&
          (detail.worktree ? (
            <Stack spacing={1}>
              <Typography variant="body2">
                Worktree <code>{detail.worktree.path}</code> on{' '}
                <code>{detail.worktree.branch ?? '(detached)'}</code>, HEAD{' '}
                <code>{detail.worktree.head?.slice(0, 10) ?? '?'}</code>
                {detail.worktree.baseRef && (
                  <>
                    , {String(detail.worktree.ahead ?? 0)} ahead /{' '}
                    {String(detail.worktree.behind ?? 0)} behind{' '}
                    <code>{detail.worktree.baseRef}</code>
                  </>
                )}
              </Typography>
              {detail.worktree.dirty.length > 0 && (
                <Alert severity="warning">Uncommitted: {detail.worktree.dirty.join(', ')}</Alert>
              )}
              <Typography variant="subtitle2">Commits on the branch</Typography>
              {detail.worktree.commits.length === 0 && (
                <Typography color="text.secondary">None yet.</Typography>
              )}
              {detail.worktree.commits.map((c) => (
                <Typography key={c.sha} variant="body2">
                  <code>{c.sha.slice(0, 8)}</code> {c.subject}
                </Typography>
              ))}
              <Typography variant="subtitle2">Changed files vs base</Typography>
              {detail.worktree.changedFiles.map((f) => (
                <Typography key={f} variant="body2">
                  <code>{f}</code>
                </Typography>
              ))}
            </Stack>
          ) : (
            <Typography color="text.secondary">
              No worktree on disk{job.worktreePath ? ` (recorded: ${job.worktreePath})` : ''}.
            </Typography>
          ))}
        {tab === 'PR' && (
          <Stack spacing={1}>
            {job.prUrl ? (
              <>
                <Typography>
                  <Link href={job.prUrl} target="_blank" rel="noreferrer noopener">
                    {job.prUrl}
                  </Link>{' '}
                  <Chip label={job.prState ?? '?'} />{' '}
                  <Chip label={`CI ${job.ciStatus ?? 'unknown'}`} color={ciColor(job.ciStatus)} />
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  CI last checked {ago(job.ciCheckedAt)}. A draft PR is not a passing build; run{' '}
                  <code>orch gh pr status {job.id}</code> to refresh.
                </Typography>
              </>
            ) : (
              <Typography color="text.secondary">No PR recorded.</Typography>
            )}
            {content('pr.md')}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

/** Verification evidence, policy state, sensitive changes, and base integrations from the plan. */
function Verification({ detail }: { detail: JobDetailView }) {
  const v = detail.plan?.verification ?? null;
  const s = detail.plan?.sensitive ?? null;
  const integ = detail.plan?.integration ?? null;
  if (!detail.plan) return <Typography color="text.secondary">Plan unavailable.</Typography>;
  return (
    <Stack spacing={2}>
      {v ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Policy
          </Typography>
          <Typography variant="body2">
            Source: <b>{v.policy.source}</b>
            {v.policy.head ? (
              <>
                {' '}
                at <code>{v.policy.head.slice(0, 10)}</code>
              </>
            ) : null}
            , fingerprint <code>{v.policy.fingerprint}</code>. Checks:{' '}
            {v.policy.checks.join(', ') || 'none'}.
          </Typography>
          {!v.configured && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              No verification policy on the base branch. Gates cannot pass until factory.json exists
              there or a proposed policy is accepted.
            </Alert>
          )}
          {v.policy.authorization === 'required' && (
            <Alert severity="warning" sx={{ mt: 1 }} data-testid="policy-drift">
              The worktree changes the verification policy. Accept it below or have it reverted.
              {v.policy.candidateError ? ` (${v.policy.candidateError})` : ''}
            </Alert>
          )}
          <Typography variant="body2" sx={{ mt: 1 }}>
            Latest run:{' '}
            {v.run ? (
              <>
                #{v.run.id}{' '}
                <Chip size="small" label={v.run.status} color={v.valid ? 'success' : 'default'} />{' '}
                at <code>{v.run.head.slice(0, 10)}</code>,{' '}
                {v.valid ? 'valid for HEAD' : `stale: ${v.reason ?? ''}`}
              </>
            ) : (
              <>none ({v.reason ?? ''})</>
            )}
          </Typography>
          {v.run && (
            <Table size="small" aria-label="Verification checks" sx={{ mt: 1 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Check</TableCell>
                  <TableCell>Command</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Exit</TableCell>
                  <TableCell align="right">ms</TableCell>
                  <TableCell>Log</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {v.run.checks.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      {c.checkId}
                      {c.required ? '' : ' (optional)'}
                    </TableCell>
                    <TableCell>
                      <code>{[c.command, ...c.args].join(' ')}</code> in {c.cwd}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={c.status}
                        color={
                          c.status === 'passed'
                            ? 'success'
                            : c.status === 'pending'
                              ? 'default'
                              : 'error'
                        }
                      />
                    </TableCell>
                    <TableCell align="right">{c.exitCode ?? c.signal ?? ''}</TableCell>
                    <TableCell align="right">{c.durationMs ?? ''}</TableCell>
                    <TableCell>
                      {c.outputPath ?? ''}
                      {c.truncated ? ' (truncated)' : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      ) : (
        <Typography color="text.secondary">No worktree; nothing verified.</Typography>
      )}
      {s &&
        (s.changes.length > 0 || s.scan.disabled.length > 0 || s.scan.removedTests.length > 0) && (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Sensitive changes {s.needsReview ? '(review required)' : '(new tests only)'}
            </Typography>
            <ul>
              {s.changes.map((c) => (
                <li key={c.path}>
                  <code>{c.path}</code> {c.status}: {c.why}
                </li>
              ))}
              {s.scan.disabled.map((d, i) => (
                <li key={`d${String(i)}`}>
                  <code>{d.path}</code> disabled or focused test: <code>{d.line}</code>
                </li>
              ))}
              {s.scan.removedTests.map((r) => (
                <li key={`r${r.path}`}>
                  <code>{r.path}</code>: {r.removed} test definition(s) removed, {r.added} added
                </li>
              ))}
            </ul>
          </Paper>
        )}
      {integ && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Base integration #{integ.id}: {integ.status}
          </Typography>
          <Typography variant="body2">
            From <code>{integ.fromHead.slice(0, 10)}</code> with {integ.baseRef} at{' '}
            <code>{integ.baseSha.slice(0, 10)}</code>
            {integ.resultHead ? (
              <>
                {' '}
                → <code>{integ.resultHead.slice(0, 10)}</code>
              </>
            ) : null}
            .{integ.conflicts?.length ? ` Conflicts: ${integ.conflicts.join(', ')}.` : ''}
            {integ.material?.length
              ? ` Edited inside the merge: ${integ.material.join(', ')}.`
              : ''}
            {integ.changedFiles?.length
              ? ` ${String(integ.changedFiles.length)} file(s) changed.`
              : ''}
          </Typography>
        </Paper>
      )}
    </Stack>
  );
}
