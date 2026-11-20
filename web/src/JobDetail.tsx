import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
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
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { JobDetailView } from '../../src/server/types.ts';
import { Actions } from './Actions.tsx';
import { CiChip, CiPanel, PrPhaseChip } from './Ci.tsx';
import { Markdown, blockingLines, section } from './Markdown.tsx';
import { ProgressSection, ProgressStrip, RoundIndicator } from './Progress.tsx';
import {
  BlockerNotes,
  BlockerText,
  CopyResume,
  FlakeText,
  ResumeBox,
  StatusChip,
  Supersession,
  nextAction,
} from './Status.tsx';
import { ApiFailure, fetchDetail } from './api.ts';
import { STATE, ago, verdictColor } from './format.ts';

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

/** What the detail page's own fetch is doing, for the app bar's shared indicator. */
export type DetailActivity = 'loading' | 'refreshing' | 'idle';

export function JobDetail({
  id,
  refreshMs = 4000,
  onActivity,
}: {
  id: string;
  refreshMs?: number;
  onActivity?: (a: DetailActivity) => void;
}) {
  const [detail, setDetail] = useState<JobDetailView | null>(null);
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabName>('Overview');
  const [tick, setTick] = useState(0);
  const [openReviews, setOpenReviews] = useState<Record<number, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      setInFlight((n) => n + 1);
      fetchDetail(id)
        .then(
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
        )
        .finally(() => {
          setInFlight((n) => n - 1);
        });
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

  const loaded = detail !== null;
  const busy = inFlight > 0;
  useEffect(() => {
    onActivity?.(!loaded ? 'loading' : busy ? 'refreshing' : 'idle');
  }, [loaded, busy, onActivity]);
  // The next detail page starts in its first load.
  useEffect(
    () => () => {
      onActivity?.('loading');
    },
    [onActivity],
  );

  if (error && !detail) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error} <Link href="#/">Back to the board</Link>
      </Alert>
    );
  }
  if (!detail) {
    return (
      <Box sx={{ p: 2 }}>
        <LinearProgress aria-label={`Loading ${id}`} />
      </Box>
    );
  }
  const { job } = detail;
  const consolidatedRounds = detail.rounds.filter((r) => r.consolidated !== null).reverse();
  const next = nextAction(detail);
  const lease = leaseText(job);
  const content = (path: string | null | undefined) =>
    path && detail.contents[path] !== undefined ? (
      <Markdown text={detail.contents[path] ?? ''} />
    ) : (
      <Typography color="text.secondary">Not available{path ? ` (${path})` : ''}.</Typography>
    );

  return (
    <Box sx={{ p: 2 }}>
      <JobHeader detail={detail} error={error} />
      <Supersession supersededBy={job.supersededBy} supersedes={detail.supersedes} />
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

      <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }} component="section" aria-label="Status">
        <Stack spacing={1}>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap' }}
          >
            <Box sx={{ flex: 1, minWidth: 240 }}>
              <Box data-testid="status-summary">
                {detail.blocker ? (
                  <BlockerText blocker={detail.blocker} ciLine={detail.ci.line} />
                ) : detail.liveness === 'completed' ? (
                  // Completed by GitHub's verdict, by a human, or before the ci stage existed.
                  <Typography data-testid="completion">{detail.ci.line}</Typography>
                ) : (
                  <Typography>{STATE[detail.liveness].describe}</Typography>
                )}
              </Box>
              {next && (
                <Typography data-testid="status-next">
                  <b>Next:</b> {next}
                </Typography>
              )}
              {detail.flake && <FlakeText flake={detail.flake} />}
            </Box>
            {detail.resume?.command && (
              <CopyResume id={job.id} command={detail.resume.command} checkout={job.repoPath} />
            )}
          </Stack>
          <Accordion
            variant="outlined"
            disableGutters
            expanded={detailsOpen}
            onChange={(_e, open) => {
              setDetailsOpen(open);
            }}
            slotProps={{ transition: { unmountOnExit: true } }}
          >
            <AccordionSummary
              expandIcon={<span aria-hidden>▾</span>}
              id="status-details-header"
              aria-controls={detailsOpen ? 'status-details-body' : undefined}
            >
              <Typography variant="body2">Details</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1}>
                {detail.blocker && <BlockerNotes blocker={detail.blocker} />}
                {detail.resume && (
                  <ResumeBox
                    resume={detail.resume}
                    cli={detail.resumeCommand}
                    state={detail.liveness}
                    checkout={job.repoPath}
                    checkoutLink={detail.links.checkout}
                    worktree={job.worktreePath}
                  />
                )}
                {job.ownerSession && (
                  <Typography variant="body2" data-testid="owner-line">
                    Owner <code>{job.ownerSession}</code>
                    {lease && `, ${lease}`}
                  </Typography>
                )}
                <Typography variant="body2" data-testid="branch-line">
                  {job.branch ? (
                    <>
                      Branch <code>{job.branch}</code> into <code>{job.baseBranch}</code>
                      {notPushed(detail) && ', not pushed yet'}
                    </>
                  ) : (
                    <>
                      Base branch <code>{job.baseBranch}</code>
                    </>
                  )}
                </Typography>
                <SessionLine session={detail.session} />
              </Stack>
            </AccordionDetails>
          </Accordion>
        </Stack>
      </Paper>

      {job.stage === 'needs-human' && <Escalation detail={detail} />}

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
              </>
            ) : (
              <Alert severity="warning">Plan unavailable: {detail.planError}</Alert>
            )}
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
            <Divider />
            <ProgressSection progress={detail.progress} timeline={detail.timeline} />
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
                  {r.round === job.round && ' (current)'}
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
                  // Collapsed by default so a round reads as a list of verdicts; the body mounts
                  // only when expanded.
                  <Accordion
                    key={rv.id}
                    variant="outlined"
                    disableGutters
                    sx={{ my: 1 }}
                    expanded={openReviews[rv.id] === true}
                    onChange={(_e, open) => {
                      setOpenReviews((s) => ({ ...s, [rv.id]: open }));
                    }}
                    slotProps={{ transition: { unmountOnExit: true } }}
                  >
                    {/* MUI gives the region this id; it is unmounted while collapsed. */}
                    <AccordionSummary
                      expandIcon={<span aria-hidden>▾</span>}
                      id={`review-${String(rv.id)}-header`}
                      aria-controls={
                        openReviews[rv.id] ? `review-${String(rv.id)}-body` : undefined
                      }
                    >
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography sx={{ fontWeight: 600 }}>{rv.reviewer}</Typography>
                        <Chip label={rv.verdict ?? 'pending'} color={verdictColor(rv.verdict)} />
                        {rv.summary && <Typography variant="body2">{rv.summary}</Typography>}
                      </Stack>
                    </AccordionSummary>
                    <AccordionDetails>
                      {rv.path ? (
                        content(rv.path)
                      ) : (
                        <Typography color="text.secondary">No review text registered.</Typography>
                      )}
                    </AccordionDetails>
                  </Accordion>
                ))}
              </Box>
            ))
          ))}
        {tab === 'Findings' &&
          (consolidatedRounds.length > 0 ? (
            consolidatedRounds.map((r) => (
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
        {tab === 'Git' && <GitTab detail={detail} />}
        {tab === 'PR' && (
          <Stack spacing={1}>
            {job.prUrl ? (
              <Typography>
                <Link href={job.prUrl} target="_blank" rel="noreferrer noopener">
                  {job.prUrl}
                </Link>{' '}
                <Chip label={job.prState ?? '?'} />
              </Typography>
            ) : (
              <Typography color="text.secondary">No PR recorded.</Typography>
            )}
            <CiPanel detail={detail} />
            {content('pr.md')}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

/** `lease until|lapsed <ISO>`, or null without a lease. */
function leaseText(job: JobDetailView['job']): string | null {
  if (!job.leaseExpiresAt) return null;
  const live = Date.parse(job.leaseExpiresAt) > Date.now();
  return `lease ${live ? 'until' : 'lapsed'} ${job.leaseExpiresAt}`;
}

/**
 * The server links the branch only with push evidence (`links.branch`); true when it could have
 * derived a link from the repository but has no such evidence yet.
 */
function notPushed(detail: JobDetailView): boolean {
  const { job } = detail;
  return (
    !job.prUrl &&
    !detail.events.some((e) => e.type === 'branch.pushed') &&
    /^github\.com\/[^/]+\/[^/]+$/.test(job.repo)
  );
}

/**
 * Two lines: identity and operational status, then delivery. A field without data is omitted;
 * the owner, lease, and base branch are tooltips here and visible lines in Details. Long values
 * break anywhere, so nothing clips.
 */
function JobHeader({ detail, error }: { detail: JobDetailView; error: string | null }) {
  const { job, ci, links } = detail;
  const lease = leaseText(job);
  const owner = job.ownerSession ? `Owner ${job.ownerSession}${lease ? `; ${lease}` : ''}` : null;
  const into = `into ${job.baseBranch}`;
  const unpushed = notPushed(detail);
  const prNumber = job.prUrl ? /\/pull\/(\d+)\/?$/.exec(job.prUrl)?.[1] : undefined;
  const delivery = [
    <span key="repo">{job.repo}</span>,
    job.branch &&
      (links.branch ? (
        <Link
          key="branch"
          href={links.branch}
          target="_blank"
          rel="noreferrer noopener"
          title={into}
        >
          <code>{job.branch}</code>
        </Link>
      ) : (
        <span key="branch" title={unpushed ? `${into}; not pushed yet` : into}>
          <code>{job.branch}</code>
        </span>
      )),
    job.prUrl && (
      <Link key="pr" href={job.prUrl} target="_blank" rel="noreferrer noopener">
        {prNumber ? `PR #${prNumber}` : 'PR'}
      </Link>
    ),
    // The CI chip already says "CI running/failing", with the head; don't repeat it.
    job.prUrl && detail.prPhase !== 'ci-running' && detail.prPhase !== 'ci-failing' && (
      <PrPhaseChip key="phase" phase={detail.prPhase} />
    ),
    (ci.status !== null || ci.completion !== null) && <CiChip key="ci" ci={ci} compact />,
    <time key="updated" dateTime={job.updatedAt} title={job.updatedAt}>
      updated {ago(job.updatedAt)}
    </time>,
  ].filter(Boolean);
  return (
    <Box component="header" data-testid="job-header" sx={{ overflowWrap: 'anywhere' }}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}
      >
        <Link href="#/" underline="hover">
          ← Jobs
        </Link>
        <Typography variant="h6" component="h1" sx={{ minWidth: 0 }}>
          {job.title}
        </Typography>
        <Typography color="text.secondary">{job.id}</Typography>
        <StatusChip state={detail.liveness} outcome={detail.outcome} tooltipExtra={owner} />
        <ProgressStrip progress={detail.progress} />
        <RoundIndicator round={job.round} maxRounds={job.maxRounds} chip />
        {job.archivedAt !== null && (
          <Tooltip title={`Archived ${job.archivedAt}; shown on the board under Show: archived`}>
            <Chip label="archived" />
          </Tooltip>
        )}
        {error && <Chip label={`refresh failed: ${error}`} color="warning" />}
      </Stack>
      <Stack
        direction="row"
        spacing={0.75}
        useFlexGap
        sx={{
          mt: 0.5,
          alignItems: 'center',
          flexWrap: 'wrap',
          typography: 'body2',
          color: 'text.secondary',
        }}
      >
        {/* Each separator sticks to its segment, so a wrapped line never starts with one. */}
        {delivery.map((part, i) => (
          <Box
            key={i}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}
          >
            {part}
            {i < delivery.length - 1 && <span aria-hidden="true">·</span>}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

type Commits = NonNullable<JobDetailView['merge']>['commits'];

/** A heading with its items, or nothing at all when there are none. */
function GitList({
  title,
  commits,
  files,
}: {
  title: string;
  commits?: Commits;
  files?: string[];
}) {
  if (!commits?.length && !files?.length) return null;
  return (
    <>
      <Typography variant="subtitle2">{title}</Typography>
      {commits?.map((c) => (
        <Typography key={c.sha} variant="body2">
          <code>{c.sha.slice(0, 8)}</code> {c.subject}
        </Typography>
      ))}
      {files?.map((f) => (
        <Typography key={f} variant="body2">
          <code>{f}</code>
        </Typography>
      ))}
    </>
  );
}

/**
 * Branch state. A merged job is described by its recorded merge, never by the current comparison
 * with the base (empty after a merge, still "ahead" after a squash).
 */
function GitTab({ detail }: { detail: JobDetailView }) {
  const { job, merge } = detail;
  const worktree = detail.plan?.worktree ?? null;
  const dirty = worktree?.dirty ?? [];
  return (
    <Stack spacing={1}>
      {merge && (
        <Typography variant="body2">
          Merged into <code>{merge.base}</code>
          {merge.prUrl && (
            <>
              {' '}
              by{' '}
              <Link href={merge.prUrl} target="_blank" rel="noreferrer noopener">
                {merge.prUrl}
              </Link>
            </>
          )}
          {merge.head && (
            <>
              {' '}
              at <code>{merge.head.slice(0, 8)}</code>
            </>
          )}
        </Typography>
      )}
      {worktree ? (
        <Typography variant="body2">
          Worktree <code>{worktree.path}</code> on <code>{worktree.branch ?? '(detached)'}</code>,
          HEAD <code>{worktree.head?.slice(0, 10) ?? '?'}</code>
          {!merge && worktree.baseRef && (
            <>
              , {String(worktree.ahead ?? 0)} ahead / {String(worktree.behind ?? 0)} behind{' '}
              <code>{worktree.baseRef}</code>
            </>
          )}
        </Typography>
      ) : (
        <Typography color="text.secondary">
          No worktree on disk{job.worktreePath ? ` (recorded: ${job.worktreePath})` : ''}.
        </Typography>
      )}
      {dirty.length > 0 && <Alert severity="warning">Uncommitted: {dirty.join(', ')}</Alert>}
      {merge ? (
        <>
          {merge.outstanding?.length === 0 && dirty.length === 0 && (
            <Typography color="text.secondary">Nothing outstanding since the merge.</Typography>
          )}
          <GitList title="Commits since the merge" commits={merge.outstanding ?? []} />
          <GitList title="Commits merged" commits={merge.commits} />
          <GitList title="Files changed" files={merge.changedFiles} />
        </>
      ) : (
        worktree && (
          <>
            <GitList title="Commits on the branch" commits={worktree.commits} />
            <GitList title="Changed files vs base" files={worktree.changedFiles} />
          </>
        )
      )}
    </Stack>
  );
}

/**
 * At needs-human, what a human deciding needs beside the Controls: the approver's DECISION marker
 * with its Rationale verbatim, and the newest consolidated round's blocking findings. The
 * BLOCKING marker is authoritative; tagged lines are listed only when it is above zero.
 */
function Escalation({ detail }: { detail: JobDetailView }) {
  const decision = detail.artifacts.find((a) => a.path === 'decision.md');
  const rationale = section(detail.contents['decision.md'] ?? '', 'Rationale');
  const latest = detail.rounds.filter((r) => r.consolidated !== null).at(-1);
  const blocking = latest?.blocking ?? 0;
  const lines =
    latest?.consolidated && blocking > 0
      ? blockingLines(section(detail.contents[latest.consolidated] ?? '', 'Findings') ?? '')
      : [];
  return (
    <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }} component="section" aria-label="Escalation">
      <Stack spacing={1}>
        <Box data-testid="decision-summary">
          {decision ? (
            <>
              <Typography sx={{ fontFamily: 'monospace', fontWeight: 700 }} data-marker="DECISION">
                DECISION: {decision.marker?.toUpperCase() ?? '?'}
              </Typography>
              {rationale ? (
                <Markdown text={rationale} />
              ) : (
                <Typography variant="body2" color="text.secondary">
                  No rationale could be read; see the Decision tab.
                </Typography>
              )}
            </>
          ) : (
            <Typography color="text.secondary">No approver decision recorded.</Typography>
          )}
        </Box>
        <Box data-testid="blocking-findings">
          {latest ? (
            <>
              <Typography sx={{ fontWeight: 600 }}>
                Round {latest.round}:{' '}
                {blocking > 0 ? `${String(blocking)} blocking finding(s)` : 'no blocking findings.'}
              </Typography>
              {lines.length > 0 && <Markdown text={lines.join('\n')} />}
            </>
          ) : (
            <Typography color="text.secondary">No consolidated findings yet.</Typography>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}

/**
 * The execution session last attached to the job, with only the navigation its provider documents:
 * an OS-handled link becomes a button, a link that resolves only inside VS Code is copied, never
 * rendered as a control that would do nothing in a browser.
 */
function SessionLine({ session }: { session: JobDetailView['session'] }) {
  if (!session) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="session-none">
        No execution session is recorded for this job; a session that resumes it records itself with{' '}
        <code>orch job session attach</code>.
      </Typography>
    );
  }
  const open = session.links.open;
  const earlier = session.previous;
  return (
    <Stack spacing={0.5} data-testid="session">
      <Typography variant="subtitle2">Execution session</Typography>
      <Typography variant="body2">
        {session.provider} <code>{session.ref}</code>
        {session.cwd ? (
          <>
            {' '}
            in <code>{session.cwd}</code>
          </>
        ) : null}
        , attached {ago(session.attachedAt)}
        {session.by ? ` by ${session.by}` : ''}
        {earlier > 0
          ? ` (${String(earlier)} earlier attachment${earlier === 1 ? '' : 's'} in the events)`
          : ''}
        .
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {open?.scope === 'os' && (
          <Button variant="outlined" href={open.url} component="a">
            Open session in VS Code
          </Button>
        )}
        {open?.scope === 'vscode-chat' && (
          <Button
            variant="outlined"
            onClick={() => {
              void navigator.clipboard.writeText(open.url);
            }}
          >
            Copy session link
          </Button>
        )}
        {session.links.resume && <code>{session.links.resume}</code>}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {session.links.note}
      </Typography>
    </Stack>
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
          {v.queue && (
            <Alert severity="info" sx={{ mt: 1 }} data-testid="verify-queue">
              {v.queue.state === 'running'
                ? `Verification running since ${new Date(v.queue.since).toLocaleString()}.`
                : `Queued for verification behind ${v.queue.holderJobId ?? 'another run'} since ` +
                  `${new Date(v.queue.since).toLocaleString()} (${String(v.queue.ahead)} ahead).`}
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
