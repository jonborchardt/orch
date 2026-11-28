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
  SvgIcon,
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
import { Fragment, useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

import type { JobDetailView } from '../../src/server/types.ts';
import { Actions } from './Actions.tsx';
import { CiChip, CiPanel, PrPhaseChip } from './Ci.tsx';
import { LogRef, PrLink, PrText, commitRef } from './Links.tsx';
import { Markdown, blockingLines, section } from './Markdown.tsx';
import { ProgressSection, ProgressStrip, RoundIndicator, When } from './Progress.tsx';
import { usePolled } from './Runs.tsx';
import { Pick } from './TicketDetail.tsx';
import { SessionLog } from './SessionLog.tsx';
import {
  BlockerNotes,
  BlockerText,
  CopyResume,
  FastChip,
  FlakeText,
  ResumeBox,
  StatusChip,
  Supersession,
  nextAction,
} from './Status.tsx';
import { failureText, fetchDetail } from './api.ts';
import {
  STATE,
  ago,
  eventDetail,
  preciseDuration,
  prNumber,
  reviewRollup,
  verdictColor,
} from './format.ts';
import { type TabName, detailTabs, jobHref, newestConsolidated, resolveTab } from './tabs.ts';
import { Remaining } from './TicketDetail.tsx';
import { ticketHref, ticketKey } from './ticketState.ts';
import { fonts, textSize, weight } from './theme.ts';

/** Material's "expand more" chevron, for every accordion here; MUI rotates it when expanded. */
function ExpandIcon() {
  return (
    <SvgIcon aria-hidden="true">
      <path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z" />
    </SvgIcon>
  );
}

/** What the detail page's own fetch is doing, for the app bar's shared indicator. */
export type DetailActivity = 'loading' | 'refreshing' | 'idle';

export function JobDetail({
  id,
  choose = null,
  tab: linked = 'Overview',
  round = null,
  reviewer = null,
  refreshMs = 4000,
  onActivity,
}: {
  id: string;
  /** `#/jobs/<id>?choose=<n>`: open choice n's confirm dialog (it acts only on Confirm). */
  choose?: number | null;
  /** The URL's tab (`#/jobs/<id>/<tab>`); a click pushes the new tab's URL. */
  tab?: TabName;
  /** `#/jobs/<id>/reviews/<round>[/<reviewer>]`: scroll to that round and expand that reviewer. */
  round?: number | null;
  reviewer?: string | null;
  refreshMs?: number;
  onActivity?: (a: DetailActivity) => void;
}) {
  const polled = usePolled(
    useCallback(() => fetchDetail(id), [id]),
    refreshMs,
  );
  const detail = polled.data;
  const error = polled.error === null ? null : failureText(polled.error);
  // What the user last picked; the rendered tab is resolveTab() of it, so it can come back.
  // A URL change (Back, Forward, a link) picks the URL's tab.
  const [selected, setSelected] = useState<TabName>(linked);
  const [seenTab, setSeenTab] = useState<TabName>(linked);
  if (seenTab !== linked) {
    setSeenTab(linked);
    setSelected(linked);
  }
  const [openReviews, setOpenReviews] = useState<Record<number, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  // A round link is followed once per link (job, round, reviewer), never again on a poll, so a
  // linked report the user collapses stays collapsed.
  const link = round === null ? null : JSON.stringify([id, round, reviewer]);
  const [followed, setFollowed] = useState<string | null>(null);
  if (link === null && followed !== null) setFollowed(null);
  // Only against this job's data: usePolled keeps the previous job's until the first response.
  if (polled.data?.job.id === id && link !== null && followed !== link) {
    setFollowed(link);
    const rv = polled.data.rounds
      .find((r) => r.round === round)
      ?.reviews.find((x) => x.reviewer === reviewer);
    if (rv) setOpenReviews((s) => ({ ...s, [rv.id]: true }));
  }
  // Runs once per followed link: `round` changes only with `followed`.
  useEffect(() => {
    if (followed === null || round === null) return;
    // Partial: jsdom has no scrollIntoView.
    const el: Partial<HTMLElement> | null = document.getElementById(
      `review-round-${String(round)}`,
    );
    el?.scrollIntoView?.({ block: 'start' });
  }, [followed, round]);
  const openTab = (t: TabName) => {
    setSelected(t);
    window.location.hash = jobHref(id, t);
  };

  const loaded = detail !== null;
  const busy = polled.loading;
  useEffect(() => {
    onActivity?.(!loaded ? 'loading' : busy ? 'refreshing' : 'idle');
  }, [loaded, busy, onActivity]);
  // The tab title on a job page (App leaves it alone here); never the previous job's.
  const jobTitle = detail?.job.id === id ? detail.job.title : null;
  useEffect(() => {
    document.title = jobTitle === null ? 'orch' : `${jobTitle} · orch`;
  }, [jobTitle]);
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
  const tabs = detailTabs(detail);
  const unavailable = tabs.filter((t) => t.unavailable !== null);
  // Derived while rendering, never in an effect: an unavailable panel is never drawn.
  const tab = resolveTab(detail, selected);
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
      {/* What a waiting job needs, and one button per choice, before anything else. */}
      <Actions
        key={`${job.id}:${String(choose)}`}
        detail={detail}
        part="choices"
        choose={choose}
        onDone={() => {
          void polled.reload();
        }}
      />
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
                  <BlockerText
                    blocker={detail.blocker}
                    ciLine={detail.ci.line}
                    pr={detail.links.pr}
                  />
                ) : detail.liveness === 'completed' ? (
                  // Completed by GitHub's verdict, by a human, or before the ci stage existed.
                  <Typography data-testid="completion">
                    <PrText text={detail.ci.line} pr={detail.links.pr} />
                  </Typography>
                ) : (
                  <Typography>{STATE[detail.liveness].describe}</Typography>
                )}
              </Box>
              {next && (
                <Typography data-testid="status-next">
                  <b>Next:</b> <PrText text={next} pr={detail.links.pr} />
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
              expandIcon={<ExpandIcon />}
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
                      {detail.links.branchUnpushed && ', not pushed yet'}
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
      {detail.finish && job.ticketId !== null && (
        <Alert severity="warning" role="region" aria-label="Needs a person" sx={{ mt: 2 }}>
          <Typography sx={{ fontWeight: weight.semibold }}>
            Needs a person: this job merged, but ticket {ticketKey(job.ticketId)} stays in progress
            with {String(detail.finish.remaining.length)} box(es) not ticked.
          </Typography>
          <Remaining finish={detail.finish} />
          <Link href={ticketHref(job.ticketId)} color="inherit">
            Finish ticket {ticketKey(job.ticketId)}: move the boxes to a follow-up, close, or rework
          </Link>
        </Alert>
      )}

      <Paper variant="outlined" sx={{ mt: 2, p: 1.5 }}>
        <Typography variant="subtitle2">Controls</Typography>
        <Actions
          detail={detail}
          onDone={() => {
            void polled.reload();
          }}
        />
      </Paper>

      <Tabs
        value={tab}
        onChange={(_e, v: TabName) => {
          // aria-disabled (unlike `disabled`) keeps the tab focusable, so clicks and Enter/Space
          // still arrive here.
          if (!tabs.find((t) => t.name === v)?.unavailable) openTab(v);
        }}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mt: 2, borderBottom: 1, borderColor: 'divider' }}
        aria-label="Job sections"
      >
        {tabs.map((t) => (
          <Tab
            key={t.name}
            label={t.label}
            value={t.name}
            id={`tab-${t.name}`}
            aria-controls={`panel-${t.name}`}
            aria-disabled={t.unavailable ? 'true' : undefined}
            aria-describedby={t.unavailable ? `tab-reason-${t.name}` : undefined}
            // The label's text cue carries the meaning; italics and a dimmer colour only echo it.
            sx={
              t.unavailable
                ? { color: 'text.disabled', cursor: 'not-allowed' }
                : t.empty
                  ? { fontStyle: 'italic' }
                  : undefined
            }
          />
        ))}
      </Tabs>
      {unavailable.length > 0 && (
        <Typography
          variant="body2"
          color="text.secondary"
          data-testid="tab-unavailable"
          sx={{ mt: 0.5 }}
        >
          Not available yet:
          {unavailable.map((t) => (
            <Fragment key={t.name}>
              {' '}
              <span id={`tab-reason-${t.name}`}>{t.unavailable}</span>
            </Fragment>
          ))}
        </Typography>
      )}
      <Box role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} sx={{ pt: 2 }}>
        {tab === 'Overview' && (
          <Stack spacing={1}>
            {job.description && (
              <Box data-testid="overview-request">
                <Typography variant="subtitle2" component="h2">
                  Request
                </Typography>
                <Typography sx={{ whiteSpace: 'pre-wrap' }}>{job.description}</Typography>
              </Box>
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
            <Stack spacing={0.5} data-testid="overview-summary">
              <ReviewsLine detail={detail} />
              <VerificationLine detail={detail} />
              <DeliveryLine detail={detail} />
            </Stack>
            <Divider />
            <ProgressSection
              progress={detail.progress}
              timeline={detail.timeline}
              tabs={tabs}
              onOpen={(t) => {
                // The Overview unmounts with the focused entry; keep focus on the tab it opened.
                flushSync(() => {
                  openTab(t);
                });
                document.getElementById(`tab-${t}`)?.focus();
              }}
            />
            <Divider />
            <Stack
              spacing={0.5}
              component="section"
              aria-labelledby="agent-session-heading"
              sx={{ color: 'text.secondary' }}
            >
              <Typography variant="subtitle2" component="h2" id="agent-session-heading">
                For the agent session
              </Typography>
              {detail.plan ? (
                <>
                  <Typography variant="body2">
                    <b>Next step:</b> {detail.plan.step} —{' '}
                    <PrText text={detail.plan.reason} pr={detail.links.pr} />
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
              <Typography variant="body2" data-testid="drawn-models">
                Models drawn:{' '}
                {detail.models
                  ? Object.entries(detail.models)
                      .map(([role, m]) => `${role} ${modelText(m.model, m.sameAsAuthor)}`)
                      .join(', ')
                  : 'not recorded'}
              </Typography>
            </Stack>
          </Stack>
        )}
        {tab === 'Spec' && content('spec.md')}
        {tab === 'Build' && content('build.md')}
        {tab === 'Reviews' &&
          (detail.rounds.length === 0 ? (
            <Typography color="text.secondary">No review rounds yet.</Typography>
          ) : (
            detail.rounds.map((r) => (
              <Box key={r.round} id={`review-round-${String(r.round)}`} sx={{ mb: 3 }}>
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <Typography variant="subtitle1" sx={{ fontWeight: weight.semibold }}>
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
                  {/* Beside the heading, not in it: its accessible name stays "Round N". */}
                  {r.reviews.length > 0 &&
                    ([true, false] as const).map((open) => (
                      <Button
                        key={String(open)}
                        aria-label={`${open ? 'Expand' : 'Collapse'} all round ${String(r.round)}`}
                        // Nothing to do when every panel is already in that state.
                        disabled={r.reviews.every((rv) => (openReviews[rv.id] === true) === open)}
                        onClick={() => {
                          setOpenReviews((s) => ({
                            ...s,
                            ...Object.fromEntries(r.reviews.map((rv) => [rv.id, open])),
                          }));
                        }}
                      >
                        {open ? 'Expand all' : 'Collapse all'}
                      </Button>
                    ))}
                </Stack>
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
                      // Expanding names the report in the URL; no history entry, no hashchange.
                      if (open) {
                        window.history.replaceState(
                          window.history.state,
                          '',
                          jobHref(job.id, 'Reviews', r.round, rv.reviewer),
                        );
                      }
                    }}
                    slotProps={{ transition: { unmountOnExit: true } }}
                  >
                    {/* MUI gives the region this id; it is unmounted while collapsed. */}
                    <AccordionSummary
                      expandIcon={<ExpandIcon />}
                      id={`review-${String(rv.id)}-header`}
                      aria-controls={
                        openReviews[rv.id] ? `review-${String(rv.id)}-body` : undefined
                      }
                    >
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography sx={{ fontWeight: weight.semibold }}>{rv.reviewer}</Typography>
                        <Chip label={rv.verdict ?? 'pending'} color={verdictColor(rv.verdict)} />
                        <Typography variant="body2" color="text.secondary">
                          {modelText(rv.model, rv.sameAsAuthor)}
                        </Typography>
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
                <Typography variant="subtitle1" sx={{ fontWeight: weight.semibold }}>
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
        {tab === 'Events' && <EventsTab events={detail.events} />}
        {tab === 'Session' && <SessionLog detail={detail} />}
        {tab === 'Git' && <GitTab detail={detail} />}
        {tab === 'PR' && (
          <Stack spacing={1}>
            {job.prUrl ? (
              <Typography>
                <PrLink url={job.prUrl} pr={detail.links.pr} /> <Chip label={job.prState ?? '?'} />
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

/**
 * The current round with its rollup (the board's chip, from that round only), the reworks so far
 * (`back` timeline entries), and the newest consolidated round's blocking count. None for fast.
 */
function ReviewsLine({ detail }: { detail: JobDetailView }) {
  const { job } = detail;
  if (job.mode === 'fast') return null;
  if (job.round < 1) {
    return (
      <Typography data-testid="summary-reviews">
        <b>Reviews:</b> No review round yet
      </Typography>
    );
  }
  const current = detail.rounds.find((r) => r.round === job.round);
  const rollup = current ? reviewRollup(current.reviews) : null;
  const reworks = detail.timeline.entries.filter((e) => e.kind === 'back').length;
  const blocking = newestConsolidated(detail)?.blocking ?? 0;
  return (
    <Typography component="div" data-testid="summary-reviews">
      <b>Reviews:</b> Round {job.round} of {job.maxRounds}{' '}
      {rollup && (
        <Chip
          size="small"
          label={rollup.label}
          color={rollup.color}
          variant={rollup.color === 'default' ? 'outlined' : 'filled'}
        />
      )}{' '}
      {reworks} rework{reworks === 1 ? '' : 's'}
      {blocking > 0 && (
        <>
          {' '}
          <Chip size="small" label={`${String(blocking)} blocking`} color="error" />
        </>
      )}
    </Typography>
  );
}

/** The latest run's status and tested HEAD, and its validity, from `plan.verification` only. */
function VerificationLine({ detail }: { detail: JobDetailView }) {
  if (!detail.plan) return null;
  const v = detail.plan.verification;
  if (!v?.run) {
    return (
      <Typography data-testid="summary-verification">
        <b>Verification:</b> Not verified yet
      </Typography>
    );
  }
  return (
    <Typography component="div" data-testid="summary-verification">
      <b>Verification:</b>{' '}
      <Chip size="small" label={v.run.status} color={v.valid ? 'success' : 'default'} /> at{' '}
      {commitRef(detail)(v.run.head, 10)}, {v.valid ? 'valid for HEAD' : `stale: ${v.reason ?? ''}`}
    </Typography>
  );
}

/** The recorded PR, its phase, and the CI line verbatim; nothing before a PR exists. */
function DeliveryLine({ detail }: { detail: JobDetailView }) {
  const { job, links } = detail;
  if (!job.prUrl) return null;
  return (
    <Typography component="div" data-testid="summary-delivery">
      <b>Delivery:</b> <PrLink url={job.prUrl} pr={links.pr} />{' '}
      <PrPhaseChip phase={detail.prPhase} /> <PrText text={detail.ci.line} pr={links.pr} />
    </Typography>
  );
}

const ONE_LINE = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;

/**
 * Every loaded event, newest first: its type, then the rest of its summary line as the handle of
 * a collapsed expander holding the raw payload. The fixed layout keeps every cell inside the page.
 */
function EventsTab({ events }: { events: JobDetailView['events'] }) {
  const [picked, setPicked] = useState('');
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  // A type that left the loaded window shows everything rather than an empty table.
  const type = counts.has(picked) ? picked : '';
  const shown = [...events].reverse().filter((e) => type === '' || e.type === type);
  return (
    <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
      <Pick
        label="Type"
        value={type}
        onChange={setPicked}
        all="All types"
        options={[...counts]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([t, n]) => ({ value: t, label: `${t} (${String(n)})` }))}
        width={200}
        size="small"
      />
      <Table
        size="small"
        aria-label="Events"
        sx={{ tableLayout: 'fixed', width: '100%', '& td': { overflowWrap: 'anywhere' } }}
      >
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: '14%' }}>Time</TableCell>
            <TableCell sx={{ width: '22%' }}>Type</TableCell>
            <TableCell sx={{ width: '18%' }}>Actor</TableCell>
            <TableCell>Summary</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.map((e) => (
            <TableRow key={e.id} data-event-type={e.type} sx={{ verticalAlign: 'top' }}>
              <TableCell>
                <When iso={e.createdAt} />
              </TableCell>
              <TableCell>{e.type}</TableCell>
              <TableCell title={e.actor ?? undefined} sx={ONE_LINE}>
                {e.actor ?? ''}
              </TableCell>
              <TableCell>
                <details>
                  <Box component="summary" sx={{ cursor: 'pointer' }}>
                    {eventDetail(e) || 'payload'}
                  </Box>
                  {/* Focusable so the keyboard can scroll a wide payload sideways. */}
                  <Box
                    component="pre"
                    tabIndex={0}
                    sx={{ m: 0, mt: 0.5, overflowX: 'auto', fontSize: textSize.code }}
                  >
                    {JSON.stringify(e.payload, null, 2)}
                  </Box>
                </details>
              </TableCell>
            </TableRow>
          ))}
          {events.length === 0 && (
            <TableRow>
              <TableCell colSpan={4}>No events recorded.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Stack>
  );
}

/** "opus (same as author: no)"; no flag for roles without an author. Null means not recorded. */
function modelText(model: string | null, same: boolean | null | undefined): string {
  const flag =
    same === undefined
      ? ''
      : ` (same as author: ${same === null ? 'not recorded' : same ? 'yes' : 'no'})`;
  return `${model ?? 'model not recorded'}${flag}`;
}

/** `lease until|lapsed <ISO>`, or null without a lease. */
function leaseText(job: JobDetailView['job']): string | null {
  if (!job.leaseExpiresAt) return null;
  const live = Date.parse(job.leaseExpiresAt) > Date.now();
  return `lease ${live ? 'until' : 'lapsed'} ${job.leaseExpiresAt}`;
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
  const unpushed = links.branchUnpushed;
  const pr = prNumber(job.prUrl);
  const delivery = [
    <span key="repo">{job.repo}</span>,
    job.ticketId !== null && (
      <Link key="ticket" href={ticketHref(job.ticketId)}>
        ticket {ticketKey(job.ticketId)}
      </Link>
    ),
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
      <PrLink key="pr" url={job.prUrl} pr={links.pr}>
        {pr ? `PR #${pr}` : 'PR'}
      </PrLink>
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
        {job.mode === 'fast' && <FastChip />}
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
  commit,
}: {
  title: string;
  commits?: Commits;
  files?: string[];
  commit?: ReturnType<typeof commitRef>;
}) {
  if (!commits?.length && !files?.length) return null;
  return (
    <>
      <Typography variant="subtitle2">{title}</Typography>
      {commits?.map((c) => (
        <Typography key={c.sha} variant="body2">
          {commit ? commit(c.sha) : <code>{c.sha.slice(0, 8)}</code>} {c.subject}
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
  const commit = commitRef(detail);
  return (
    <Stack spacing={1}>
      {merge && (
        <Typography variant="body2">
          Merged into <code>{merge.base}</code>
          {merge.prUrl && (
            <>
              {' '}
              by <PrLink url={merge.prUrl} pr={detail.links.pr} />
            </>
          )}
          {merge.head && <> at {commit(merge.head)}</>}
          {merge.mergeCommit && <>, merge commit {commit(merge.mergeCommit)}</>}
          {merge.verified === false && <> (not the CI-verified head)</>}
        </Typography>
      )}
      {worktree ? (
        <Typography variant="body2">
          Worktree <code>{worktree.path}</code> on <code>{worktree.branch ?? '(detached)'}</code>,
          HEAD {worktree.head ? commit(worktree.head, 10) : <code>?</code>}
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
          <GitList
            title="Commits since the merge"
            commits={merge.outstanding ?? []}
            commit={commit}
          />
          <GitList title="Commits merged" commits={merge.commits} commit={commit} />
          <GitList title="Files changed" files={merge.changedFiles} />
        </>
      ) : (
        worktree && (
          <>
            <GitList title="Commits on the branch" commits={worktree.commits} commit={commit} />
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
  const latest = newestConsolidated(detail);
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
              <Typography
                sx={{ fontFamily: fonts.mono, fontWeight: weight.bold }}
                data-marker="DECISION"
              >
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
              <Typography sx={{ fontWeight: weight.semibold }}>
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

type Run = JobDetailView['verificationRuns'][number];

/** One run's checks; a log is a link only when the server listed it in `links.logs`. */
function ChecksTable({ run, logs }: { run: Run; logs: JobDetailView['links']['logs'] }) {
  return (
    <Table size="small" aria-label={`Verification checks of run ${String(run.id)}`} sx={{ mt: 1 }}>
      <TableHead>
        <TableRow>
          <TableCell>Check</TableCell>
          <TableCell>Command</TableCell>
          <TableCell>Status</TableCell>
          <TableCell align="right">Exit</TableCell>
          <TableCell align="right">Duration</TableCell>
          <TableCell>Log</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {run.checks.map((c) => (
          <TableRow key={c.id}>
            <TableCell>
              {c.checkId}
              {c.required ? '' : ' (optional)'}
            </TableCell>
            <TableCell>
              <code>{[c.command, ...c.args].join(' ')}</code>
              {c.cwd === '.' ? '' : ` in ${c.cwd}`}
            </TableCell>
            <TableCell>
              <Chip
                size="small"
                label={c.status}
                color={
                  c.status === 'passed' ? 'success' : c.status === 'pending' ? 'default' : 'error'
                }
              />
            </TableCell>
            <TableCell align="right">{c.exitCode ?? c.signal ?? ''}</TableCell>
            <TableCell align="right">{preciseDuration(c.durationMs)}</TableCell>
            <TableCell>
              {c.outputPath ? <LogRef path={c.outputPath} href={logs[c.outputPath]} /> : ''}
              {c.truncated ? ' (truncated)' : ''}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The runs before the one shown as latest, each collapsed with its checks unmounted until opened.
 * The chip is never the success colour: an earlier run is history, not evidence for HEAD. The
 * summary is a button, so it names the tested commit as text; the commit link is in the body.
 */
function EarlierRuns({
  runs,
  logs,
  commit,
}: {
  runs: Run[];
  logs: JobDetailView['links']['logs'];
  commit: ReturnType<typeof commitRef>;
}) {
  return (
    <Box data-testid="earlier-runs">
      <Typography variant="subtitle1" sx={{ fontWeight: weight.semibold }}>
        Earlier runs
      </Typography>
      {runs.map((r) => (
        <Accordion
          key={r.id}
          variant="outlined"
          disableGutters
          sx={{ my: 1 }}
          slotProps={{ transition: { unmountOnExit: true } }}
        >
          {/* A div with role="button": its content is block-level, which a <button> may not hold. */}
          <AccordionSummary
            component="div"
            expandIcon={<ExpandIcon />}
            id={`run-${String(r.id)}-header`}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography sx={{ fontWeight: weight.semibold }}>#{r.id}</Typography>
              <Chip size="small" label={r.status} />
              <Typography variant="body2" color="text.secondary">
                {r.completedAt ? (
                  <>
                    <When iso={r.completedAt} />, took{' '}
                    {preciseDuration(Date.parse(r.completedAt) - Date.parse(r.startedAt))}
                  </>
                ) : (
                  <>
                    started <When iso={r.startedAt} />
                  </>
                )}
              </Typography>
              <Typography variant="body2">
                at <code>{r.head.slice(0, 10)}</code>
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2">Tested commit: {commit(r.head, 10)}</Typography>
            <ChecksTable run={r} logs={logs} />
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}

/**
 * Verification evidence, policy state, sensitive changes, and base integrations from the plan,
 * then the job's earlier runs. Only the latest run carries a validity statement, and only from
 * `plan.verification`; without a worktree the recorded runs are listed with none.
 */
function Verification({ detail }: { detail: JobDetailView }) {
  const v = detail.plan?.verification ?? null;
  const s = detail.plan?.sensitive ?? null;
  const integ = detail.plan?.integration ?? null;
  if (!detail.plan) return <Typography color="text.secondary">Plan unavailable.</Typography>;
  const commit = commitRef(detail);
  const latest = v ? v.run : (detail.verificationRuns[0] ?? null);
  const earlier = detail.verificationRuns.filter((r) => r.id !== latest?.id);
  const latestRun = latest && (
    <>
      <Typography variant="body2" sx={{ mt: 1 }}>
        Latest run: #{latest.id}{' '}
        <Chip size="small" label={latest.status} color={v?.valid ? 'success' : 'default'} /> at{' '}
        {commit(latest.head, 10)}
        {v ? `, ${v.valid ? 'valid for HEAD' : `stale: ${v.reason ?? ''}`}` : ''}
      </Typography>
      <ChecksTable run={latest} logs={detail.links.logs} />
    </>
  );
  return (
    <Stack spacing={2}>
      {v ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: weight.semibold }}>
            Policy
          </Typography>
          <Typography variant="body2">
            Source: <b>{v.policy.source}</b>
            {v.policy.head ? <> at {commit(v.policy.head, 10)}</> : null}, fingerprint{' '}
            <code>{v.policy.fingerprint}</code>. Checks: {v.policy.checks.join(', ') || 'none'}.
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
          {latestRun ?? (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Latest run: none ({v.reason ?? ''})
            </Typography>
          )}
        </Paper>
      ) : latestRun ? (
        <Paper variant="outlined" sx={{ p: 2 }}>
          {latestRun}
        </Paper>
      ) : (
        <Typography color="text.secondary">No worktree; nothing verified.</Typography>
      )}
      {earlier.length > 0 && (
        <EarlierRuns runs={earlier} logs={detail.links.logs} commit={commit} />
      )}
      {s &&
        (s.changes.length > 0 || s.scan.disabled.length > 0 || s.scan.removedTests.length > 0) && (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: weight.semibold }}>
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
          <Typography variant="subtitle1" sx={{ fontWeight: weight.semibold }}>
            Base integration #{integ.id}: {integ.status}
          </Typography>
          <Typography variant="body2">
            From {commit(integ.fromHead, 10)} with {integ.baseRef} at {commit(integ.baseSha, 10)}
            {integ.resultHead ? <> → {commit(integ.resultHead, 10)}</> : null}.
            {integ.conflicts?.length ? ` Conflicts: ${integ.conflicts.join(', ')}.` : ''}
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
