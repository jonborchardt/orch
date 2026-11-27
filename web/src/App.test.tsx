// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { ThemeProvider } from '@mui/material';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BoardRow,
  CiView,
  JobDetailView,
  Progress,
  SessionLogView,
} from '../../src/server/types.ts';
import { App } from './App.tsx';
import { CiChip } from './Ci.tsx';
import {
  byAttention,
  ciColor,
  commitHref,
  httpsHref,
  localTime,
  prParts,
  repoLabels,
  reviewRollup,
  STATE,
} from './format.ts';
import { Markdown } from './Markdown.tsx';
import { RUNNING_WINDOW_MS, subagentState } from './SessionLog.tsx';
import { RESUME_NOTE } from './Status.tsx';
import { TABS, detailTabs, resolveTab } from './tabs.ts';
import { theme } from './theme.ts';

// The full suite runs ~20 process-heavy files in parallel; the 1 s default flakes under that load.
configure({ asyncUtilTimeout: 10_000 });

const STEP_IDS = ['spec', 'build', 'simplify', 'review', 'approve', 'pr', 'ci', 'done'] as const;
const STEP_LABELS = ['Spec', 'Build', 'Simplify', 'Review', 'Approve', 'PR', 'CI', 'Done'];
/** A progress model as the server builds it: steps before `position` done, after it not started. */
function progress(position: number, at: 'current' | 'stopped', label: string): Progress {
  return {
    steps: STEP_IDS.map((id, i) => ({
      id,
      label: STEP_LABELS[i] ?? id,
      state: i < position ? 'done' : i === position ? at : 'not-started',
    })),
    position,
    label,
    specChallenge: null,
  };
}

function row(over: Partial<BoardRow>): BoardRow {
  return {
    id: 'job-00000001',
    title: 'Job',
    repo: 'github.com/acme/alpha',
    repoPath: '/r',
    stage: 'build',
    status: 'running',
    mode: 'full',
    liveness: 'running',
    outcome: null,
    round: 0,
    maxRounds: 3,
    owner: { session: 'claude-1', leaseExpiresAt: '2999-01-01T00:00:00.000Z', live: true },
    worktreePath: '/wt',
    branch: 'factory/job-00000001-job',
    reviews: [],
    blocking: null,
    blocker: null,
    resume: null,
    startedAt: '2026-11-13T08:00:00.000Z',
    updatedAt: '2026-11-13T08:30:00.000Z',
    elapsedMs: 1_800_000,
    pr: { url: null, state: null, phase: 'no-pr', refreshable: false },
    supersededBy: null,
    supersedes: [],
    ticketId: null,
    archivedAt: null,
    ci: noCi(),
    progress: progress(1, 'current', 'Build'),
    flake: null,
    ...over,
  };
}

function noCi(over: Partial<CiView> = {}): CiView {
  return {
    head: null,
    current: null,
    status: null,
    checkedAt: null,
    repairs: 0,
    maxRepairs: 2,
    outcome: null,
    reason: null,
    failures: [],
    completion: null,
    line: '',
    guidance: '',
    ...over,
  };
}

const rows: BoardRow[] = [
  row({ id: 'job-00000001', title: 'Alpha running' }),
  row({
    id: 'job-00000002',
    title: 'Beta stale',
    repo: 'github.com/acme/beta',
    liveness: 'stale',
    owner: { session: 'claude-2', leaseExpiresAt: '2000-01-01T00:00:00.000Z', live: false },
    reviews: [
      { reviewer: 'security', verdict: 'pass' },
      { reviewer: 'correctness', verdict: null },
    ],
    blocking: 2,
    round: 1,
    blocker: {
      kind: 'interrupted',
      summary: 'Session claude-2 stopped renewing its lease; presumed gone',
      detail: null,
    },
    resume: { command: '/factory resume job-00000002', heldBy: null },
    stage: 'review',
    progress: progress(3, 'current', 'Review'),
  }),
  row({
    id: 'job-00000003',
    title: 'Gamma blocked',
    repo: 'gamma',
    stage: 'needs-human',
    status: 'blocked',
    liveness: 'blocked',
    blocker: {
      kind: 'decision',
      summary: 'Approver escalated: a human must decide',
      detail: 'AC2 needs deployment verification',
    },
    resume: { command: '/factory resume job-00000003', heldBy: null },
    pr: {
      url: 'https://github.com/x/y/pull/1',
      state: 'draft',
      phase: 'ci-failing',
      refreshable: false,
    },
    ci: noCi({ status: 'failing', head: 'abcdef0123456789', outcome: 'failing', repairs: 1 }),
    progress: progress(6, 'stopped', 'CI, needs human'),
  }),
  row({
    id: 'job-00000004',
    title: 'Delta cancelled',
    repo: 'gamma',
    stage: 'build',
    status: 'cancelled',
    liveness: 'cancelled',
    owner: null,
    progress: progress(1, 'stopped', 'Build, cancelled'),
    blocker: {
      kind: 'cancelled',
      summary: 'Cancelled during build by dashboard',
      detail: 'superseded by job-00000005',
    },
  }),
];

const longFindings = Array.from(
  { length: 40 },
  (_, i) => `${String(i + 1)}. [MINOR] file.ts:${String(i)} — finding ${String(i + 1)} → fix`,
).join('\n');

function detail(over: Partial<JobDetailView> = {}): JobDetailView {
  return {
    job: {
      id: 'job-00000003',
      title: 'Gamma blocked',
      description: 'Do the thing',
      repo: 'gamma',
      repoPath: '/g',
      issueRef: null,
      baseBranch: 'main',
      branch: 'factory/job-00000003-gamma',
      worktreePath: '/wt/g',
      stage: 'needs-human',
      status: 'blocked',
      mode: 'full',
      round: 1,
      maxRounds: 3,
      returnStage: 'approve',
      ownerSession: null,
      leaseExpiresAt: null,
      leaseMinutes: 30,
      prUrl: null,
      prState: null,
      ciStatus: null,
      ciCheckedAt: null,
      ciHead: null,
      ciRepairs: 0,
      maxCiRepairs: 2,
      scopeReworks: 0,
      revision: 9,
      createdAt: '2026-11-13T08:00:00.000Z',
      startedAt: '2026-11-13T08:00:00.000Z',
      updatedAt: '2026-11-13T08:30:00.000Z',
      completedAt: null,
      policy: null,
      policyHead: null,
      supersededBy: null,
      ticketId: null,
      archivedAt: null,
      mailCursor: null,
      mailThreadId: null,
      mailSubject: null,
      mailLastId: null,
    },
    models: null,
    liveness: 'blocked',
    outcome: null,
    artifacts: [],
    contents: {
      'round-1/consolidated.md': `# C\n\n## Findings\n\n${longFindings}\n\nBLOCKING: 0\n`,
    },
    rounds: [{ round: 1, reviews: [], consolidated: 'round-1/consolidated.md', blocking: 0 }],
    events: [],
    eventsCapped: false,
    plan: null,
    planError: 'config broken',
    verificationRuns: [],
    blocker: {
      kind: 'decision',
      summary: 'Approver escalated: a human must decide',
      detail: 'AC2 needs deployment verification',
    },
    ci: noCi(),
    progress: progress(4, 'stopped', 'Approve, needs human'),
    timeline: { entries: [] },
    prPhase: 'no-pr',
    actions: ['approve', 'request-review', 'request-rework', 'cancel'],
    choices: null,
    needed: null,
    afterAction: null,
    conflicts: null,
    links: {
      vscode: 'vscode://file//wt/g',
      checkout: 'vscode://file//g',
      pr: null,
      repo: null,
      branch: null,
      branchUnpushed: false,
      pushedHeads: [],
      logs: {},
    },
    session: null,
    claudeSessions: [],
    resume: { command: '/factory resume job-00000003', heldBy: null },
    resumeCommand: 'orch factory resume job-00000003 --session <name>',
    supersedes: [],
    flake: null,
    merge: null,
    ...over,
  };
}

type FetchMock = ReturnType<typeof vi.fn>;

/** Pick a native select's option by its label, as a user does. */
async function choose(select: string, option: string | RegExp) {
  const el = screen.getByRole('combobox', { name: select });
  const opt = await within(el).findByRole<HTMLOptionElement>('option', { name: option });
  fireEvent.change(el, { target: { value: opt.value } });
}

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected an element');
  return x;
}
const boardRowOf = (id: string) =>
  must(document.querySelector<HTMLElement>(`[data-job-id="${id}"]`));
/** Expands the detail status panel's Details (collapsed by default, unmounted while closed). */
function openDetails() {
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
}
let data: {
  rows: BoardRow[];
  detail: JobDetailView;
  actionStatus: number;
  actionBody: unknown;
  sessionLog: SessionLogView;
  /** `/api/runner`'s body; unset, the request fails like any unmocked route. */
  runner?: unknown;
  /** `/api/jobs/:id/readiness`'s body; unset, the request fails like any unmocked route. */
  readiness?: unknown;
};
const ATTACH = 'orch job session attach job-00000003 --provider claude-code';
const NO_SESSION =
  "No Claude Code session is recorded for this job. A job's session records itself when it starts " +
  'or resumes through /factory; jobs started before session logs were recorded have none.';
const SESSION_UUID = '565e2b23-152d-4533-b6b3-e1d4981c7297';
const noSessionLog = (): SessionLogView => ({
  found: false,
  reason: NO_SESSION,
  ref: null,
  attach: ATTACH,
  matches: 0,
  files: [],
  subagents: [],
  subagentsNotRead: 0,
  entries: [],
  truncated: false,
});
const IDLE_RUNNER = { controllers: [], last: null, build: null, waiting: [] };
/** While set, board or detail responses wait for the promise (a held request). */
let hold: { board?: Promise<void>; detail?: Promise<void> } = {};

function mockFetch(): FetchMock {
  const f = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    if (url.startsWith('/api/jobs?') || url === '/api/jobs')
      return (hold.board ?? Promise.resolve()).then(() => json(200, data.rows));
    if (url === '/api/runner' && data.runner !== undefined) return json(200, data.runner);
    if (url === '/api/repos') return json(200, [...new Set(data.rows.map((r) => r.repo))]);
    if (url === '/api/session')
      return json(200, { csrf: 'tok', version: '0', database: 'db', actions: [] });
    if (/^\/api\/jobs\/job-[0-9a-f]{8}\/actions$/.test(url) && init?.method === 'POST') {
      return json(data.actionStatus, data.actionBody);
    }
    if (/^\/api\/jobs\/job-[0-9a-f]{8}\/session-log$/.test(url)) return json(200, data.sessionLog);
    if (/^\/api\/jobs\/job-[0-9a-f]{8}\/readiness$/.test(url) && data.readiness !== undefined)
      return json(200, data.readiness);
    if (/^\/api\/jobs\/job-[0-9a-f]{8}$/.test(url))
      return (hold.detail ?? Promise.resolve()).then(() => json(200, data.detail));
    return json(404, { error: { type: 'NotFoundError', message: `no ${url}` } });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

function mount(refreshMs = 50) {
  return render(
    <ThemeProvider theme={theme} defaultMode="light">
      <App refreshMs={refreshMs} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
  hold = {};
  data = {
    rows,
    detail: detail(),
    sessionLog: noSessionLog(),
    actionStatus: 200,
    actionBody: {
      job: detail().job,
      message: 'Recorded: job returned to approve (pending). No session is running it; resume it',
      resumeCommand: 'orch factory resume job-00000003 --session <name>',
      supersedes: [],
    },
    // The shared header polls the runner on every section; idle unless a test says otherwise.
    runner: IDLE_RUNNER,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App board', () => {
  it('shows the empty state when there are no jobs', async () => {
    data.rows = [];
    mockFetch();
    mount();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No jobs yet');
    });
  });

  it('renders every repository and distinguishes running from stale', async () => {
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    const chipOf = (id: string) =>
      must(
        must(table.querySelector(`[data-job-id="${id}"]`)).querySelector<HTMLElement>(
          '[data-state]',
        ),
      );
    const live = chipOf('job-00000001');
    const lapsed = chipOf('job-00000002');
    expect(live).toHaveAttribute('data-state', 'running');
    expect(live).toHaveTextContent(/^● running$/);
    expect(lapsed).toHaveAttribute('data-state', 'stale');
    expect(lapsed).toHaveTextContent(/^◌ stale$/);
    expect(within(table).queryByText(/running \(lease live\)|last reported running/)).toBeNull();
    // The tooltip carries the lease meaning; stale never claims the session ended.
    expect(live.getAttribute('title')).toMatch(/renewed its ownership lease/);
    const staleTip = must(lapsed.getAttribute('title'));
    expect(staleTip).toMatch(/lease lapsed/);
    for (const claim of ['has stopped', 'is gone', 'is dead', 'presumed gone']) {
      expect(staleTip).not.toContain(claim);
      expect(must(RESUME_NOTE.stale)).not.toContain(claim);
    }
    // Exact status-chip text: the progress strip's label ("CI, needs human") also says it.
    expect(within(table).getByText('⚠ needs human')).toBeInTheDocument();
    // One verdict rollup per row, with the blocking count folded in; reviewers only in its tooltip.
    expect(within(table).getByText('1/2, 1 pending')).toBeInTheDocument();
    expect(within(table).getByText('2 blocking')).toBeInTheDocument();
    expect(within(table).queryByText('correctness: pending')).not.toBeInTheDocument();
    expect(within(table).getByText('CI failing @abcdef0')).toBeInTheDocument();
    // The repairs count describes rounds, so it sits in the Round column, never under the CI chip.
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    const cellOf = (id: string, label: string) => {
      const index = headers.findIndex((h) => h.startsWith(label));
      expect(index).toBeGreaterThanOrEqual(0);
      const tr = must(table.querySelector<HTMLElement>(`tr[data-job-id="${id}"]`));
      return must(tr.querySelectorAll<HTMLElement>('td')[index]);
    };
    expect(cellOf('job-00000003', 'Round')).toHaveTextContent('repairs 1/2');
    expect(cellOf('job-00000003', 'PR / CI')).toHaveTextContent('CI failing @abcdef0');
    expect(cellOf('job-00000003', 'PR / CI')).not.toHaveTextContent('repairs');
    // Before the first round the indicator reads `-` (AC7), and no repairs caption without a repair.
    expect(cellOf('job-00000001', 'Round')).toHaveTextContent(
      /^-No review round yet \(at most 3\)$/,
    );
    // Repository is hidden by default (Columns menu); the job ids still identify each row.
    expect(within(table).queryByText('github.com/acme/beta')).not.toBeInTheDocument();
    expect(within(table).getByText('job-00000002')).toBeInTheDocument();
    expect(screen.getByText('1 stale')).toBeInTheDocument();
  });

  it('never styles a cancelled job as a success, and keeps stage apart from status', async () => {
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    const cancelled = must(table.querySelector<HTMLElement>('[data-job-id="job-00000004"]'));
    const chip = must(cancelled.querySelector<HTMLElement>('[data-state]'));
    expect(chip).toHaveAttribute('data-state', 'cancelled');
    expect(chip).toHaveTextContent('cancelled');
    expect(chip.className).toContain('MuiChip-colorDefault');
    expect(chip.className).not.toContain('MuiChip-colorSuccess');
    // The workflow step it stopped at is still shown, as a step, next to the cancelled status.
    expect(within(cancelled).getByText('Build, cancelled')).toBeInTheDocument();
    expect(within(cancelled).getByText(/superseded by job-00000005/)).toBeInTheDocument();
    // A cancelled job cannot be resumed, so no resume control is offered.
    expect(
      within(cancelled).queryByRole('button', { name: /Copy resume command/ }),
    ).not.toBeInTheDocument();
    // Only a truly completed job gets the success colour.
    data.rows = [row({ id: 'job-00000001', liveness: 'completed', status: 'completed' })];
    await waitFor(() => {
      expect(screen.getByText(/✓ completed/)).toBeInTheDocument();
    });
    expect(
      must(screen.getByText(/✓ completed/).closest<HTMLElement>('[data-state]')).className,
    ).toContain('MuiChip-colorSuccess');
  });

  it('explains blockers on the board and offers resume only for eligible jobs', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    const f = mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    expect(
      within(table).getByText(
        'Approver escalated: a human must decide: AC2 needs deployment verification',
      ),
    ).toBeInTheDocument();
    expect(within(table).getByText(/presumed gone/)).toBeInTheDocument();
    const copies = within(table).getAllByRole('button', { name: /Copy resume command/ });
    expect(copies.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Copy resume command for job-00000003',
      'Copy resume command for job-00000002',
    ]);
    fireEvent.click(must(copies[0]));
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith('/factory resume job-00000003');
    });
    expect(
      await screen.findByText(/Paste it into a Claude Code session opened in \/r/),
    ).toBeVisible();
    // Copying is presentation only: nothing was posted.
    expect(
      f.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('clamps the board blocker line at two lines with its full text in a hover or focus tooltip', async () => {
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    const line = must(table.querySelector<HTMLElement>('[data-blocker="decision"]'));
    expect(line).toHaveAttribute('tabindex', '0');
    const style = getComputedStyle(line);
    expect(style.whiteSpace).toBe('normal');
    expect(style.overflow).toBe('hidden');
    expect(style.cursor).toBe('help');
    const full =
      'Decision needed — Approver escalated: a human must decide: AC2 needs deployment verification';
    fireEvent.mouseOver(line);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(full);
    fireEvent.mouseLeave(line);
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
    line.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(full);
  });

  it('shows why the factory controller stopped a job on the board and in the detail', async () => {
    const stopped = {
      kind: 'stopped' as const,
      summary: 'Factory controller stopped it: no-progress',
      detail: 'Two Claude sessions in a row changed nothing.',
      next: 'orch do 0088',
    };
    data.rows = [
      row({
        id: 'job-00000003',
        title: 'Gamma blocked',
        status: 'pending',
        liveness: 'idle',
        owner: null,
        blocker: stopped,
      }),
    ];
    const base = detail();
    data.detail = detail({
      job: { ...base.job, stage: 'build', status: 'pending' },
      liveness: 'idle',
      blocker: stopped,
    });
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    const line = must(table.querySelector<HTMLElement>('[data-blocker="stopped"]'));
    expect(line).toHaveTextContent(`${stopped.summary}: ${stopped.detail}`);
    window.location.hash = '#/jobs/job-00000003';
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByTestId('status-summary')).toHaveTextContent(
      `Stopped by the controller. ${stopped.summary}: ${stopped.detail}`,
    );
    expect(screen.getByTestId('status-next')).toHaveTextContent('Next: orch do 0088');
  });

  it('shows workflow progress in the Stage cell: where it stopped, with glyphs and a focus tooltip', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    const gamma = boardRowOf('job-00000003');
    const strip = within(gamma).getByRole('img', { name: /^Progress: CI, needs human\./ });
    expect(strip).toHaveTextContent('needs human');
    // The internal stage name never appears; the step and why it stopped do.
    expect(gamma).not.toHaveTextContent('needs-human');
    expect(strip).toHaveAccessibleName(
      'Progress: CI, needs human. Spec: done, Build: done, Simplify: done, Review: done, Approve: done, PR: done, CI: stopped, Done: not started',
    );
    // Not colour alone: each step carries a glyph for its state.
    const glyphs = [...strip.querySelectorAll<HTMLElement>('[data-step]')];
    expect(glyphs.map((g) => `${g.dataset['step'] ?? ''}:${g.textContent}`)).toEqual([
      'spec:✓',
      'build:✓',
      'simplify:✓',
      'review:✓',
      'approve:✓',
      'pr:✓',
      'ci:■',
      'done:○',
    ]);
    // Colours follow the active light or dark scheme (CSS variables), never fixed light values.
    expect(glyphs.map((g) => g.style.color)).toEqual([
      ...Array<string>(6).fill('var(--mui-palette-success-main)'),
      'var(--mui-palette-error-main)',
      'var(--mui-palette-text-secondary)',
    ]);
    expect(strip).toHaveAttribute('tabindex', '0');
    strip.focus();
    const tip = await screen.findByRole('tooltip');
    const lines = [...tip.querySelectorAll('div')].filter((d) => d.children.length === 0);
    expect(lines.map((d) => d.textContent)).toEqual([
      '✓ Spec: done',
      '✓ Build: done',
      '✓ Simplify: done',
      '✓ Review: done',
      '✓ Approve: done',
      '✓ PR: done',
      '■ CI: stopped',
      '○ Done: not started',
    ]);
  });

  it('shows Elapsed as Unknown, <1s, or a duration, and defines it in a header tooltip', async () => {
    data.rows = [
      row({ id: 'job-00000001', elapsedMs: null }),
      row({ id: 'job-00000002', elapsedMs: 400 }),
      row({ id: 'job-00000003', elapsedMs: 1_800_000 }),
    ];
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(within(boardRowOf('job-00000001')).getByText('Unknown')).toBeInTheDocument();
    const short = boardRowOf('job-00000002');
    expect(within(short).getByText('<1s')).toBeInTheDocument();
    expect(within(short).queryByText('0s')).toBeNull();
    expect(within(boardRowOf('job-00000003')).getByText('30m')).toBeInTheDocument();
    const sort = screen.getByRole('button', { name: 'Elapsed' });
    sort.focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/wall-clock/i);
    expect(tip).toHaveTextContent(/creation/);
    expect(tip).toHaveTextContent(/completed or was cancelled/);
    // Unknown sorts after every known span, not among the short ones.
    fireEvent.click(sort);
    expect(
      [...document.querySelectorAll('[data-job-id]')].map((e) => e.getAttribute('data-job-id')),
    ).toEqual(['job-00000002', 'job-00000003', 'job-00000001']);
  });

  it('defines Round, Reviews, Updated, and PR / CI in header tooltips', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    const tipOf = async (name: string) => {
      const sort = screen.getByRole('button', { name });
      sort.focus();
      const tip = await screen.findByRole('tooltip');
      const text = tip.textContent;
      sort.blur();
      await waitFor(() => {
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      });
      return text;
    };
    const round = await tipOf('Round');
    expect(round).toMatch(/review rounds/i);
    expect(round).toMatch(/repairs line/);
    expect(round).toMatch(/CI repairs/);
    const reviews = await tipOf('Reviews');
    expect(reviews).toMatch(/rollup/);
    expect(reviews).toMatch(/blocking count/);
    const updated = await tipOf('Updated');
    expect(updated).toMatch(/job row last changed/);
    expect(updated).toMatch(/not the session's last activity/);
    const pr = await tipOf('PR / CI');
    expect(pr).toMatch(/as orch last recorded/);
    expect(pr).toMatch(/only Merge or Refresh PR/);
  });

  it('shows Started as a local date and time or —, and sorts unstarted jobs last', async () => {
    const later = '2026-11-13T09:00:00.000Z';
    const earlier = '2026-11-12T07:15:00.000Z';
    data.rows = [
      // With a PR, so Started's is the row's only dash (a row without a PR shows one too).
      row({
        id: 'job-00000001',
        startedAt: null,
        pr: {
          url: 'https://github.com/x/y/pull/1',
          state: 'draft',
          phase: 'draft',
          refreshable: false,
        },
      }),
      row({ id: 'job-00000002', startedAt: later }),
      row({ id: 'job-00000003', startedAt: earlier }),
    ];
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(within(boardRowOf('job-00000001')).getByText('—')).toBeInTheDocument();
    const shown = within(boardRowOf('job-00000003')).getByText(new Date(earlier).toLocaleString());
    expect(shown).toHaveAttribute('dateTime', earlier);
    const sort = screen.getByRole('button', { name: 'Started' });
    sort.focus();
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/not when it was created/);
    fireEvent.click(sort);
    expect(
      [...document.querySelectorAll('[data-job-id]')].map((e) => e.getAttribute('data-job-id')),
    ).toEqual(['job-00000003', 'job-00000002', 'job-00000001']);
  });

  it('shows the review round as "-" before the first round and "N / M" after, with a tooltip', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    // Visible text is hidden from assistive technology; the words are read instead, as text
    // (aria-label is prohibited on a generic span).
    const visible = (el: HTMLElement) => el.querySelector('[aria-hidden]')?.textContent;
    const zero = within(boardRowOf('job-00000001')).getByTestId('round');
    expect(visible(zero)).toBe('-');
    expect(zero).toHaveTextContent('-No review round yet (at most 3)');
    expect(zero).not.toHaveAttribute('aria-label');
    expect(zero).toHaveAttribute('tabindex', '0');
    data.rows = [row({ id: 'job-00000001', round: 2 })];
    await waitFor(() => {
      expect(visible(within(boardRowOf('job-00000001')).getByTestId('round'))).toBe('2 / 3');
    });
    const two = within(boardRowOf('job-00000001')).getByTestId('round');
    expect(two).toHaveTextContent('Review round 2 of at most 3');
    two.focus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Review round 2 of at most 3');
    cleanup();
    data.detail = detail({ job: { ...detail().job, round: 0 } });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    // The chip's read text starts with its visible text (label in name).
    const chip = await screen.findByTestId('round');
    expect(chip).toHaveTextContent(/^Round: none\. No review round yet \(at most 3\)$/);
    expect(chip).not.toHaveAttribute('aria-label');
    data.detail = detail({ job: { ...detail().job, round: 2 } });
    await waitFor(() => {
      expect(screen.getByTestId('round')).toHaveTextContent(
        /^Round 2 \/ 3\. Review round 2 of at most 3$/,
      );
    });
  });

  it('puts the strip in the detail header and the steps and timeline in Overview', async () => {
    mockFetch();
    const at = (m: number) => `2026-11-13T08:${String(m).padStart(2, '0')}:00.000Z`;
    data.detail = detail({
      job: { ...detail().job, stage: 'build', status: 'pending', returnStage: null },
      liveness: 'idle',
      blocker: null,
      progress: progress(1, 'current', 'Build'),
      eventsCapped: true,
      timeline: {
        entries: [
          { at: at(1), step: 'build', kind: 'started', label: 'Build started' },
          { at: at(2), step: 'build', kind: 'completed', label: 'Build completed' },
          { at: at(3), step: 'ci', kind: 'started', label: 'CI started' },
          { at: at(4), step: 'ci', kind: 'back', label: 'Rework from CI: back to Build' },
          { at: at(5), step: 'build', kind: 'started', label: 'Build started' },
        ],
      },
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    const strip = screen.getByRole('img', { name: /^Progress: Build\./ });
    expect(strip).toHaveAccessibleName(
      'Progress: Build. Spec: done, Build: current, Simplify: not started, Review: not started, Approve: not started, PR: not started, CI: not started, Done: not started',
    );
    expect(screen.queryByText(/stage:/)).not.toBeInTheDocument();
    const section = screen.getByTestId('progress-section');
    const steps = within(section).getByRole('list', { name: 'Workflow steps' });
    // The same states as the strip, in order.
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('data-step-state')),
    ).toEqual(['done', 'current', ...Array<string>(6).fill('not-started')]);
    // Times read as elsewhere on the dashboard ("… ago"); the ISO value stays in `datetime`, and
    // the tooltip is the local date and time with zone (ticket 0018).
    const build = within(steps).getAllByRole('listitem')[1];
    expect(build).toHaveTextContent(/started .* ago/);
    expect(build?.querySelector('time')).toHaveAttribute('datetime', at(5));
    expect(build?.querySelector('time')).toHaveAttribute('title', localTime(at(5)));
    expect(localTime(at(5))).not.toBe(at(5));
    const timeline = within(section).getByRole('table', { name: 'Timeline' });
    const timelineRows = within(timeline).getAllByRole<HTMLTableRowElement>('row');
    expect(timelineRows.map((r) => r.querySelector('time')?.getAttribute('datetime'))).toEqual(
      [1, 2, 3, 4, 5].map(at),
    );
    expect(timelineRows.map((r) => r.cells[1]?.textContent)).toEqual([
      'Build started',
      'Build completed',
      'CI started',
      'Rework from CI: back to Build',
      'Build started',
    ]);
    expect(timelineRows[0]?.cells[0]).toHaveTextContent(/ ago$/);
    // The timeline is complete (ticket 0016): no "earlier history" note, even at the events cap.
    expect(within(section).queryByText(/Earlier history/)).toBeNull();
    // No spec challenge to show: no sub-item.
    expect(within(section).queryByTestId('spec-challenge')).toBeNull();
  });

  it('shows the spec challenge under Spec in the strip and the Progress section (ticket 0081)', async () => {
    mockFetch();
    const withChallenge = (
      position: number,
      label: string,
      specChallenge: Progress['specChallenge'],
    ): Progress => ({ ...progress(position, 'current', label), specChallenge });
    data.rows = [
      row({
        id: 'job-00000001',
        progress: withChallenge(1, 'Build', { verdict: 'pass', revised: true }),
      }),
    ];
    data.detail = detail({
      job: { ...detail().job, stage: 'spec', status: 'running', returnStage: null },
      liveness: 'idle',
      blocker: null,
      progress: withChallenge(0, 'Spec', { verdict: 'pending', revised: false }),
    });
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    const strip = within(boardRowOf('job-00000001')).getByRole('img', {
      name: /^Progress: Build\./,
    });
    // The existing text stays; the challenge follows the Spec step's state. Still eight glyphs.
    expect(strip).toHaveAccessibleName(
      'Progress: Build. Spec: done, spec challenge passed after a revision, Build: current, Simplify: not started, Review: not started, Approve: not started, PR: not started, CI: not started, Done: not started',
    );
    expect(strip.querySelectorAll('[data-step]')).toHaveLength(8);
    strip.focus();
    const tip = await screen.findByRole('tooltip');
    const lines = [...tip.querySelectorAll('div')].filter((d) => d.children.length === 0);
    expect(lines[0]?.textContent).toBe('✓ Spec: done, spec challenge passed after a revision');
    expect(lines[1]?.textContent).toBe('▶ Build: current');
    cleanup();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByRole('img', { name: /^Progress: Spec\./ })).toHaveAccessibleName(
      /^Progress: Spec\. Spec: current, spec challenge pending, Build: not started,/,
    );
    const section = screen.getByTestId('progress-section');
    const sub = within(section).getByTestId('spec-challenge');
    // Under the Spec item, with a glyph and the words, never colour alone.
    expect(sub.closest('[data-step]')).toHaveAttribute('data-step', 'spec');
    expect(sub).toHaveTextContent('▶Spec challenge: pending');
    expect(sub).not.toHaveTextContent('spec revised');
    data.detail = detail({
      progress: withChallenge(1, 'Build', { verdict: 'changes', revised: true }),
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId('progress-section')).getByTestId('spec-challenge'),
      ).toHaveTextContent('■Spec challenge: changes requested (spec revised)');
    });
    data.detail = detail({
      progress: withChallenge(1, 'Build', { verdict: 'pass', revised: false }),
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId('progress-section')).getByTestId('spec-challenge'),
      ).toHaveTextContent(/^✓Spec challenge: passed$/);
    });
  });

  it('labels sections, tabs, and control buttons in sentence case, never uppercase (ticket 0166)', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const upper = (el: HTMLElement) => getComputedStyle(el).textTransform;
    expect(upper(within(nav).getByRole('link', { name: 'Jobs' }))).not.toBe('uppercase');
    expect(upper(screen.getByRole('button', { name: 'Columns' }))).not.toBe('uppercase');
    window.location.hash = '#/jobs/job-00000003';
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(upper(screen.getByRole('tab', { name: 'Overview' }))).not.toBe('uppercase');
  });

  it('filters cancelled jobs separately from finished ones', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    await choose('Show', 'cancelled (1)');
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(2);
    });
    expect(screen.getByText('Delta cancelled')).toBeInTheDocument();
  });

  it('renders Filter, Repository, and Show only on the board, keeping their values', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter' }), {
      target: { value: 'delta' },
    });
    await choose('Show', 'cancelled (1)');
    window.location.hash = '#/jobs/job-00000003';
    fireEvent(window, new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('searchbox', { name: 'Filter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Repository' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Show' })).not.toBeInTheDocument();
    // The summary chips stay on every route.
    expect(screen.getByLabelText('Summary')).toBeInTheDocument();
    window.location.hash = '#/';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(await screen.findByRole('searchbox', { name: 'Filter' })).toHaveValue('delta');
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveDisplayValue('cancelled (1)');
    expect(screen.getByRole('combobox', { name: 'Repository' })).toBeInTheDocument();
    expect(await screen.findByText('Delta cancelled')).toBeInTheDocument();
  });

  it('refreshes while state changes underneath it', async () => {
    const f = mockFetch();
    mount();
    await screen.findByText('Alpha running');
    data.rows = [
      row({
        id: 'job-00000001',
        title: 'Alpha running',
        liveness: 'completed',
        status: 'completed',
        stage: 'completed',
      }),
    ];
    await waitFor(() => {
      expect(screen.getByText(/✓ completed/)).toBeInTheDocument();
    });
    expect(f.mock.calls.length).toBeGreaterThan(2);
  });

  it('shows API errors without crashing', async () => {
    mockFetch();
    data.rows = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { type: 'Boom', message: 'db locked' } }), {
            status: 500,
          }),
        ),
      ),
    );
    mount();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Boom: db locked');
    });
    // A failed first load shows the error, not a loading bar that never ends.
    expect(screen.queryByRole('progressbar', { name: 'Loading jobs' })).not.toBeInTheDocument();
  });
});

describe('Installed build warning', () => {
  const message = 'built from aaaaaaa, main is at bbbbbbb: pull, `npm run build`, `orch install`';
  const runner = (stale: boolean) => ({
    controllers: [],
    last: null,
    waiting: [],
    build: { builtFrom: 'a', head: 'b', upstream: null, stale, message },
  });

  it('warns above the Jobs tab when the installed build is stale', async () => {
    data.runner = runner(true);
    mockFetch();
    mount();
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('shows nothing when the build is current or /api/runner fails', async () => {
    for (const r of [runner(false), undefined]) {
      data.runner = r;
      const f = mockFetch();
      mount();
      await screen.findByRole('table', { name: 'Factory jobs' });
      await waitFor(() => {
        expect(f.mock.calls.some(([u]) => u === '/api/runner')).toBe(true);
      });
      expect(screen.queryByText(message)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      cleanup();
    }
  });

  it('comes from the header runner poll on another section, which keeps polling (ticket 0136)', async () => {
    data.runner = runner(true);
    const f = mockFetch();
    window.location.hash = '#/runs';
    mount();
    expect(await screen.findByText(message)).toBeInTheDocument();
    const asked = () => f.mock.calls.filter(([u]) => u === '/api/runner').length;
    const seen = asked();
    await waitFor(() => {
      expect(asked()).toBeGreaterThan(seen);
    });
  });
});

describe('Shared header (ticket 0136)', () => {
  it('shows one Factory status box with the state chip on every section', async () => {
    for (const hash of [
      '#/',
      '#/jobs/job-00000003',
      '#/tickets',
      '#/tickets/1',
      '#/runs',
      '#/agents',
      '#/usage',
    ]) {
      mockFetch();
      window.location.hash = hash;
      mount();
      const r = await screen.findByRole('region', { name: 'Factory status' });
      await waitFor(() => {
        expect(r.querySelector('[data-runner]')).toHaveAttribute('data-runner', 'idle');
      });
      expect(screen.getAllByRole('region', { name: 'Factory status' })).toHaveLength(1);
      cleanup();
    }
  });

  it('has no plain Refresh button on a job detail page', async () => {
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });
});

describe('Job detail', () => {
  it('renders long findings, the plan error, and a working Resume at <stage> action', async () => {
    const f = mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText(/Plan unavailable: config broken/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Findings (0 blocking)' }));
    expect(screen.getByText(/finding 40/)).toBeInTheDocument();
    expect(screen.getByText('BLOCKING: 0')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open worktree in VS Code' })).toHaveAttribute(
      'href',
      'vscode://file//wt/g',
    );

    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume at approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume at approve' });
    expect(
      within(dialog).getByText(/does not start or wake any Claude session/),
    ).toBeInTheDocument();
    // The title follows the stage select: it names the stage Confirm sends.
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Resume at stage' }));
    fireEvent.click(await screen.findByRole('option', { name: 'review' }));
    expect(dialog).toHaveAccessibleName('Resume at review');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No session is running it');
    });
    expect(
      within(screen.getByRole('status')).getByText(
        'orch factory resume job-00000003 --session <name>',
      ),
    ).toBeInTheDocument();
    const calls = f.mock.calls as [RequestInfo | URL, RequestInit | undefined][];
    const posted = calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(posted?.[1]?.body as string)).toEqual({ action: 'approve', to: 'review' });
  });

  it('offers the recorded choices as buttons and answers one with an optional note', async () => {
    const f = mockFetch();
    data.detail = detail({
      actions: ['approve', 'answer', 'request-rework', 'cancel'],
      choices: [
        {
          kind: 'resume',
          to: 'approve',
          label: 'Approve as is',
          action: 'approve',
          available: true,
          effect: 'the job goes back to approve and carries on from there',
        },
        {
          kind: 'review',
          label: 'Review again',
          action: 'request-review',
          available: false,
          effect: 'the reviewers look at the current change again',
        },
        {
          kind: 'cancel',
          label: 'Drop it',
          action: 'cancel',
          available: true,
          effect: 'the job ends for good; its branch and worktree are kept',
        },
      ],
      needed: 'The approver asks a person to decide: pick "Approve as is" or "Drop it".',
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    const block = await screen.findByTestId('choices');
    // What is needed and each choice's effect, from the server, before the Escalation section.
    expect(within(block).getByTestId('needed')).toHaveTextContent(
      'The approver asks a person to decide',
    );
    expect(
      within(block)
        .getAllByTestId('choice-effect')
        .map((e) => e.textContent),
    ).toEqual([
      'the job goes back to approve and carries on from there',
      'the reviewers look at the current change again (not available now)',
      'the job ends for good; its branch and worktree are kept',
    ]);
    const escalation = screen.getByRole('region', { name: 'Escalation' });
    expect(
      block.compareDocumentPosition(escalation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(block).getByRole('button', { name: 'Approve as is' })).toBeEnabled();
    // The first choice is the primary one; the others are outlined.
    expect(within(block).getByRole('button', { name: 'Approve as is' })).toHaveClass(
      'MuiButton-contained',
    );
    expect(within(block).getByRole('button', { name: 'Drop it' })).toHaveClass(
      'MuiButton-outlined',
    );
    expect(within(block).queryByTestId('after-action')).not.toBeInTheDocument();
    expect(within(block).getByRole('button', { name: 'Review again' })).toBeDisabled();
    // The existing controls stay.
    expect(screen.getByRole('button', { name: 'Resume at approve' })).toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: 'Drop it' }));
    const dialog = await screen.findByRole('dialog', { name: 'Drop it' });
    expect(within(dialog).getByTestId('action-effect')).toHaveTextContent(
      'Ends the job as cancelled',
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Note \(optional/ }), {
      target: { value: ' not needed ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
    const calls = f.mock.calls as [RequestInfo | URL, RequestInit | undefined][];
    const posted = calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(posted?.[1]?.body as string)).toEqual({
      action: 'answer',
      choice: 2,
      reason: 'not needed',
    });
  });

  it('shows the effect of a resume choice and renders no Choices block without choices', async () => {
    mockFetch();
    data.detail = detail({
      actions: ['approve', 'answer', 'cancel'],
      choices: [
        {
          kind: 'resume',
          to: 'ci',
          label: 'Retry CI',
          action: 'approve',
          available: true,
          effect: 'e',
        },
        { kind: 'cancel', label: 'Drop it', action: 'cancel', available: true, effect: 'e' },
      ],
      afterAction: 'the controller continues it',
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    expect(await screen.findByTestId('after-action')).toHaveTextContent(
      'After an answer, the controller continues it.',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Retry CI' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retry CI' });
    expect(within(dialog).getByTestId('action-effect')).toHaveTextContent(
      'Moves the job to ci as pending',
    );
    cleanup();
    data.detail = detail();
    mount();
    await screen.findByRole('button', { name: 'Resume at approve' });
    expect(screen.queryByTestId('choices')).not.toBeInTheDocument();
  });

  it('opens the choice a ?choose= link names, posting nothing until Confirm', async () => {
    const f = mockFetch();
    const choices: JobDetailView['choices'] = [
      {
        kind: 'resume',
        to: 'ci',
        label: 'Retry CI',
        action: 'approve',
        available: true,
        effect: 'e',
      },
      { kind: 'cancel', label: 'Drop it', action: 'cancel', available: true, effect: 'e' },
      {
        kind: 'review',
        label: 'Look again',
        action: 'request-review',
        available: false,
        effect: 'e',
      },
    ];
    const posts = () =>
      (f.mock.calls as [RequestInfo | URL, RequestInit | undefined][]).filter(
        ([, init]) => init?.method === 'POST',
      );
    data.detail = detail({ choices });
    window.location.hash = '#/jobs/job-00000003?choose=1';
    mount();
    const dialog = await screen.findByRole('dialog', { name: 'Drop it' });
    expect(within(dialog).getAllByRole('button', { name: 'Confirm' })).toHaveLength(1);
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(JSON.parse(posts()[0]?.[1]?.body as string)).toEqual({ action: 'answer', choice: 1 });

    // Out of range, unavailable, or a job not in needs-human: the page, no dialog, no POST.
    for (const [hash, over] of [
      ['#/jobs/job-00000003?choose=7', { choices }],
      ['#/jobs/job-00000003?choose=2', { choices }],
      ['#/jobs/job-00000003?choose=0', {}],
    ] as const) {
      cleanup();
      f.mockClear();
      data.detail = detail(over);
      window.location.hash = hash;
      mount();
      await screen.findByRole('button', { name: 'Resume at approve' });
      expect(screen.queryByRole('dialog'), hash).not.toBeInTheDocument();
      expect(posts(), hash).toHaveLength(0);
    }
  });

  it('labels Resume by the current return stage, even when it changes under a mounted view', async () => {
    const f = mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('button', { name: 'Resume at approve' });
    // The next poll reports a different return stage; the view is not remounted.
    data.detail = detail({ job: { ...detail().job, returnStage: 'ci' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Resume at CI' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resume at CI' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No session is running it');
    });
    const calls = f.mock.calls as [RequestInfo | URL, RequestInit | undefined][];
    const posted = calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(posted?.[1]?.body as string)).toEqual({ action: 'approve', to: 'ci' });
  });

  it('surfaces an invalid command as an error inside the dialog', async () => {
    mockFetch();
    data.actionStatus = 422;
    data.actionBody = {
      error: {
        type: 'ValidationError',
        message: 'Session claude-9 holds a live lease on this job.',
      },
    };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('button', { name: 'Request rework' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(
        within(dialog).getByText(/ValidationError: Session claude-9 holds a live lease/),
      ).toBeInTheDocument();
    });
  });

  it('makes Resume primary only at a genuine approval gate, with the resume affordance', async () => {
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText('Decision needed.')).toBeInTheDocument();
    // The recorded reason is part of the one summary sentence.
    expect(screen.getByTestId('status-summary')).toHaveTextContent(
      'Approver escalated: a human must decide: AC2 needs deployment verification',
    );
    expect(screen.getByTestId('status-next')).toHaveTextContent(
      "Read the approver's decision below, then Resume at approve or Request rework.",
    );
    const approve = screen.getByRole('button', { name: 'Resume at approve' }).className;
    expect(approve).toContain('MuiButton-contained');
    expect(approve).toContain('MuiButton-colorSuccess');
    expect(screen.queryByTestId('approve-caution')).not.toBeInTheDocument();
    // The command's particulars wait in Details; the copy button does not.
    expect(screen.queryByTestId('resume')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Copy resume command/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Copy resume command/ })).toBeVisible();
    openDetails();
    const resume = await screen.findByTestId('resume');
    expect(within(resume).getByText('/factory resume job-00000003')).toBeInTheDocument();
    expect(within(resume).getByText(/opened in/).textContent).toContain('/g');
    expect(within(resume).getByText(/Copying does not resume anything/)).toBeInTheDocument();
    expect(within(resume).getByRole('link', { name: 'Open checkout in VS Code' })).toHaveAttribute(
      'href',
      'vscode://file//g',
    );
    // The header names the step it stopped at, never the internal stage string.
    expect(screen.getByRole('img', { name: /^Progress: Approve, needs human\./ })).toBeVisible();
    expect(screen.queryByText(/needs-human/)).not.toBeInTheDocument();
  });

  it('demotes Resume and admits an unknown reason when the escalation is not a decision', async () => {
    mockFetch();
    data.detail = detail({
      job: { ...detail().job, returnStage: null },
      blocker: { kind: 'escalated', summary: 'Escalated from build', detail: null },
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByTestId('status-next')).toHaveTextContent(
      'No control is recommended; read the events and artifacts, then choose.',
    );
    expect(screen.queryByText(/No reason was recorded/)).not.toBeInTheDocument();
    openDetails();
    expect(await screen.findByText(/No reason was recorded/)).toBeVisible();
    // No recorded return stage: Resume defaults to build.
    const approve = screen.getByRole('button', { name: 'Resume at build' });
    expect(approve.className).toContain('MuiButton-outlined');
    expect(approve.className).not.toContain('MuiButton-colorSuccess');
    expect(screen.getByTestId('approve-caution')).toHaveTextContent('not waiting for an approval');
    expect(screen.getByTestId('approve-caution')).not.toHaveTextContent('Approve');
    // Unknown blocker: no control is promoted.
    expect(screen.getByRole('button', { name: 'Request rework' }).className).toContain(
      'MuiButton-outlined',
    );
  });

  it('promotes Request rework only when review rounds are exhausted', async () => {
    mockFetch();
    data.detail = detail({
      blocker: {
        kind: 'findings',
        summary: '2 blocking finding(s) remain after the last allowed review round',
        detail: null,
      },
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByTestId('status-next')).toHaveTextContent(
      'Request rework to address the blocking findings, or cancel.',
    );
    expect(screen.getByRole('button', { name: 'Request rework' }).className).toContain(
      'MuiButton-contained',
    );
    expect(screen.getByRole('button', { name: 'Resume at approve' }).className).toContain(
      'MuiButton-outlined',
    );
  });

  it('withholds the resume command while another session holds a live lease', async () => {
    mockFetch();
    const base = detail();
    data.rows = [
      row({
        id: 'job-00000003',
        title: 'Gamma blocked',
        stage: 'needs-human',
        status: 'blocked',
        liveness: 'blocked',
        blocker: base.blocker,
        resume: {
          command: null,
          heldBy: { session: 'claude-9', leaseExpiresAt: '2999-01-01T00:00:00.000Z' },
        },
      }),
    ];
    data.detail = detail({
      job: { ...base.job, ownerSession: 'claude-9', leaseExpiresAt: '2999-01-01T00:00:00.000Z' },
      resume: {
        command: null,
        heldBy: { session: 'claude-9', leaseExpiresAt: '2999-01-01T00:00:00.000Z' },
      },
    });
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    expect(
      within(table).queryByRole('button', { name: /Copy resume command/ }),
    ).not.toBeInTheDocument();
    expect(
      within(table).getByText(/Resume unavailable: session claude-9 holds a live lease/),
    ).toBeInTheDocument();
    cleanup();

    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByTestId('resume-unavailable')).not.toBeInTheDocument();
    openDetails();
    expect(screen.queryByTestId('resume')).not.toBeInTheDocument();
    const unavailable = await screen.findByTestId('resume-unavailable');
    expect(unavailable).toHaveTextContent('claude-9');
    expect(unavailable).toHaveTextContent('never forces ownership');
    expect(screen.queryByRole('button', { name: /Copy resume command/ })).not.toBeInTheDocument();
    // The decision gate itself is unaffected by who holds the lease.
    expect(screen.getByRole('button', { name: 'Resume at approve' }).className).toContain(
      'MuiButton-contained',
    );
  });

  it('offers recovery, not approval, for an interrupted job and nothing for a cancelled one', async () => {
    mockFetch();
    const base = detail();
    data.detail = detail({
      job: { ...base.job, stage: 'build', status: 'interrupted', round: 0, returnStage: null },
      liveness: 'interrupted',
      blocker: {
        kind: 'interrupted',
        summary: 'Interrupted while running under session claude-7',
        detail: null,
      },
      actions: ['request-rework', 'cancel'],
      resume: { command: '/factory resume job-00000003', heldBy: null },
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('button', { name: /^Resume at / })).not.toBeInTheDocument();
    // An interruption is not a rework decision: every remaining control stays neutral.
    expect(screen.getByRole('button', { name: 'Request rework' }).className).toContain(
      'MuiButton-outlined',
    );
    expect(screen.getByText('Interrupted.')).toBeInTheDocument();
    expect(screen.getByTestId('status-next')).toHaveTextContent(
      "Resume from a Claude Code session in the job's checkout.",
    );
    expect(screen.getByRole('button', { name: /Copy resume command/ })).toBeVisible();
    openDetails();
    expect(await screen.findByTestId('resume')).toHaveTextContent('/factory resume job-00000003');
    expect(screen.getByTestId('resume')).toHaveTextContent('takes the job over');
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument();
    cleanup();

    data.detail = detail({
      job: { ...base.job, stage: 'build', status: 'cancelled', completedAt: base.job.updatedAt },
      liveness: 'cancelled',
      blocker: { kind: 'cancelled', summary: 'Cancelled during build', detail: 'dup' },
      actions: [],
      resume: null,
    });
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText('No actions: the job is cancelled.')).toBeInTheDocument();
    expect(screen.queryByTestId('resume')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel job' })).not.toBeInTheDocument();
    expect(screen.getByTestId('status-summary')).toHaveTextContent('Cancelled during build: dup');
    expect(screen.queryByTestId('status-next')).not.toBeInTheDocument();
  });

  it('offers Accept delivery only when the server lists it, requires a reason, and labels the result', async () => {
    const f = mockFetch();
    const base = detail();
    const ciNone = noCi({
      head: 'b2c3d4e5f6071829',
      status: 'none',
      outcome: 'none',
      checkedAt: base.job.updatedAt,
      guidance:
        'Add CI and Resume at CI, or accept the delivery by hand (recorded as a human close-out).',
    });
    data.detail = detail({
      job: {
        ...base.job,
        returnStage: 'ci',
        prUrl: 'https://github.com/x/y/pull/9',
        prState: 'draft',
        ciStatus: 'none',
        ciHead: 'b2c3d4e5f6071829',
      },
      links: { ...base.links, pr: 'https://github.com/x/y/pull/9' },
      ci: ciNone,
      blocker: {
        kind: 'ci',
        summary: 'GitHub reports no checks for the PR head',
        detail: 'no required checks',
      },
      actions: ['approve', 'request-review', 'request-rework', 'accept-delivery', 'cancel'],
    });
    data.actionBody = {
      job: { ...data.detail.job, stage: 'completed', status: 'completed' },
      message:
        'Delivery accepted by a human (dashboard: reviewed by hand): the job is completed without a passing CI verdict. CI was none for b2c3d4e; the PR is draft. Nothing was merged or marked ready.',
    };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText('CI stopped.')).toBeInTheDocument();
    expect(screen.queryByTestId('ci-guidance')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-next')).toHaveTextContent(`Next: ${ciNone.guidance}`);
    expect(screen.getByTestId('close-out-caution')).toHaveTextContent('CI is none for b2c3d4e');
    expect(screen.getByRole('button', { name: 'Resume at CI' })).toBeInTheDocument();
    // Neutral, never primary: a close-out is a human override, not the workflow's own next step.
    const accept = screen.getByRole('button', { name: 'Accept delivery' });
    expect(accept.className).toContain('MuiButton-outlined');
    expect(screen.getByRole('button', { name: 'Request rework' }).className).toContain(
      'MuiButton-outlined',
    );
    fireEvent.click(accept);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/completes the job without a passing CI verdict/),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'reviewed by hand' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Delivery accepted by a human');
    });
    const calls = f.mock.calls as [RequestInfo | URL, RequestInit | undefined][];
    const posted = calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(posted?.[1]?.body as string)).toEqual({
      action: 'accept-delivery',
      reason: 'reviewed by hand',
    });
    cleanup();

    // Without the server's permission there is no button, whatever the CI state says.
    data.detail = detail({
      ci: noCi({
        line: 'CI still failing for d4e5f60; 1 of 1 repairs used.',
        guidance: 'The repair budget is spent.',
        head: 'd4e5f60718293041',
        status: 'failing',
        outcome: 'failing',
        repairs: 1,
        maxRepairs: 1,
      }),
      job: {
        ...base.job,
        returnStage: 'ci',
        prUrl: 'https://github.com/x/y/pull/9',
        prState: 'draft',
        ciStatus: 'failing',
        ciHead: 'd4e5f60718293041',
        ciRepairs: 1,
        maxCiRepairs: 1,
      },
      links: { ...base.links, pr: 'https://github.com/x/y/pull/9' },
      blocker: {
        kind: 'ci',
        summary: 'CI still failing after 1 of 1 repair cycles',
        detail: 'CI failed: test',
      },
      actions: ['approve', 'request-review', 'request-rework', 'cancel'],
    });
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('button', { name: 'Accept delivery' })).not.toBeInTheDocument();
    // A ci blocker's summary is the CI line; its recorded reason waits in Details.
    expect(screen.getByTestId('status-summary')).toHaveTextContent(
      'CI stopped. CI still failing for d4e5f60; 1 of 1 repairs used.',
    );
    expect(screen.getByTestId('status-summary')).not.toHaveTextContent('CI failed: test');
    expect(screen.getByTestId('status-next')).toHaveTextContent('repair budget is spent');
    openDetails();
    expect(await screen.findByText('Recorded reason: CI failed: test')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'PR' }));
    // The budget is stated once, in the CI line; the CI chip carries no round count.
    expect(screen.getByTestId('ci-panel')).not.toHaveTextContent('Repairs used:');
    expect(screen.getByTestId('ci-panel')).not.toHaveTextContent('repairs 1/1');
    expect(screen.getByTestId('ci-panel')).toHaveTextContent(
      'CI still failing for d4e5f60; 1 of 1 repairs used.',
    );
    expect(screen.getByTestId('ci-panel')).toHaveTextContent('CI failing @d4e5f60');
  });

  it('the CI chip says only what CI is doing: no repairs count, still flags a stale head', () => {
    render(
      <CiChip
        ci={noCi({
          status: 'failing',
          head: 'abcdef0123456789',
          outcome: 'failing',
          repairs: 1,
          current: false,
        })}
        compact
      />,
    );
    expect(screen.getByText('CI failing @abcdef0')).toBeInTheDocument();
    expect(screen.getByText('not current HEAD')).toBeInTheDocument();
    expect(screen.queryByText(/repairs/)).not.toBeInTheDocument();
  });

  it('Markdown renders headings, lists, code, markers, and never HTML', () => {
    render(
      <Markdown
        text={
          '# Title\n\n## Findings\n\n- [BLOCKING] `a.ts:1` — **bad** → fix\n1. one\n\n```\ncode <b>x</b>\n```\n\n<script>alert(1)</script>\n\nVERDICT: CHANGES\n'
        }
      />,
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Findings')).toBeInTheDocument();
    expect(screen.getByText('a.ts:1')).toBeInTheDocument();
    expect(screen.getByText('bad')).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('code <b>x</b>')).toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('VERDICT: CHANGES')).toHaveAttribute('data-marker', 'VERDICT');
  });
});

describe('Job detail: header', () => {
  const branch = 'factory/job-00000003-gamma';
  const prUrl = 'https://github.com/x/y/pull/9';
  const header = () => screen.getByTestId('job-header');
  /** On GitHub with a pushed branch, a PR, and CI failing for a head. */
  function delivered(over: Partial<JobDetailView> = {}): JobDetailView {
    const base = detail();
    return detail({
      job: { ...base.job, repo: 'github.com/x/y', prUrl, prState: 'draft' },
      links: { ...base.links, pr: prUrl, branch: `https://github.com/x/y/tree/${branch}` },
      ci: noCi({ status: 'failing', head: 'abcdef0123456789', outcome: 'failing' }),
      prPhase: 'ci-failing',
      ...over,
    });
  }
  async function open(d: JobDetailView) {
    data.detail = d;
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
  }
  const before = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it('line 1 is title, id, status, then progress; delivery chips and buttons are elsewhere', async () => {
    await open(delivered());
    const h = header();
    const line1 = must(h.firstElementChild as HTMLElement | null);
    const title = within(line1).getByRole('heading', { name: 'Gamma blocked' });
    const id = within(line1).getByText('job-00000003');
    const status = must(line1.querySelector('[data-state]'));
    const strip = within(line1).getByRole('img', { name: /^Progress:/ });
    expect(before(title, id) && before(id, status) && before(status, strip)).toBe(true);
    expect(line1.querySelector('[data-phase]')).toBeNull();
    expect(line1.querySelector('[data-ci]')).toBeNull();
    // The buttons exist on the page, outside the header.
    expect(screen.getByRole('link', { name: 'Open PR on GitHub' })).toBeInTheDocument();
    expect(within(h).queryByRole('link', { name: 'Open PR on GitHub' })).toBeNull();
    expect(within(h).queryByRole('link', { name: 'Open worktree in VS Code' })).toBeNull();
    expect(within(h).queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('line 2 links the branch and PR and shows CI and the last update', async () => {
    await open(delivered());
    const h = header();
    expect(h).toHaveTextContent('github.com/x/y');
    expect(within(h).getByRole('link', { name: branch })).toHaveAttribute(
      'href',
      `https://github.com/x/y/tree/${branch}`,
    );
    expect(within(h).getByRole('link', { name: branch })).toHaveAttribute('title', 'into main');
    expect(within(h).getByRole('link', { name: 'PR #9' })).toHaveAttribute('href', prUrl);
    expect(within(h).getByText('CI failing @abcdef0')).toBeInTheDocument();
    expect(within(h).getByText(/^updated /)).toBeInTheDocument();
  });

  it('omits absent fields instead of printing placeholders', async () => {
    await open(detail({ job: { ...detail().job, branch: null } }));
    const h = header();
    for (const text of ['branch —', 'branch -']) expect(h).not.toHaveTextContent(text);
    expect(h.textContent).not.toMatch(/owner/i);
    expect(h.querySelector('[data-phase]')).toBeNull();
    expect(h.querySelector('[data-ci]')).toBeNull();
    expect(within(h).queryByRole('link', { name: /^PR/ })).toBeNull();
    // The repository is shown exactly as recorded, as its own segment.
    expect(within(h).getByText(detail().job.repo)).toBeInTheDocument();
    expect(within(h).getByText(/^updated /)).toBeInTheDocument();
    // The base branch, no longer in the header text, is a visible line in Details.
    openDetails();
    expect(await screen.findByTestId('branch-line')).toHaveTextContent('Base branch main');
  });

  it('keeps the owner and lease in the status tooltip and the update time in its own', async () => {
    const lease = '2999-01-01T00:00:00.000Z';
    await open(
      detail({ job: { ...detail().job, ownerSession: 'claude-9', leaseExpiresAt: lease } }),
    );
    const h = header();
    expect(h).not.toHaveTextContent('claude-9');
    expect(h).not.toHaveTextContent(lease);
    const title = must(h.querySelector('[data-state]')).getAttribute('title') ?? '';
    expect(title).toContain('claude-9');
    expect(title).toContain(`lease until ${lease}`);
    const updated = within(h).getByText(/^updated /);
    expect(updated).toHaveAttribute('title', detail().job.updatedAt);
    // A <time> element exposes the exact time to assistive technology, not only as a tooltip.
    expect(updated.tagName).toBe('TIME');
    expect(updated).toHaveAttribute('datetime', detail().job.updatedAt);
  });

  it('names a lapsed owner in Details, and nothing when there is no owner', async () => {
    const lapsed = '2000-01-01T00:00:00.000Z';
    await open(
      detail({
        job: { ...detail().job, ownerSession: 'claude-9', leaseExpiresAt: lapsed },
        liveness: 'stale',
        resume: { command: '/factory resume job-00000003', heldBy: null },
      }),
    );
    openDetails();
    const line = await screen.findByTestId('owner-line');
    expect(line).toHaveTextContent('claude-9');
    expect(line).toHaveTextContent(`lease lapsed ${lapsed}`);
    cleanup();

    await open(detail());
    openDetails();
    await screen.findByTestId('session-none');
    expect(screen.queryByTestId('owner-line')).not.toBeInTheDocument();
  });

  it('says CI failing once, and shows the phase chip when the CI chip does not say it', async () => {
    await open(delivered());
    expect(within(header()).getAllByText(/CI failing/)).toHaveLength(1);
    expect(header().querySelector('[data-phase="ci-failing"]')).toBeNull();
    cleanup();

    await open(
      delivered({
        ci: noCi({ status: 'passing', head: 'abcdef0123456789', completion: 'ci' }),
        prPhase: 'ready-to-merge',
      }),
    );
    expect(header().querySelector('[data-phase="ready-to-merge"]')).not.toBeNull();
  });

  it('names an unparsable PR URL plainly, and a PR without CI data has no CI chip', async () => {
    const odd = 'https://example.test/pr';
    await open(
      delivered({
        job: { ...delivered().job, prUrl: odd },
        links: { ...delivered().links, pr: odd },
        ci: noCi(),
        prPhase: 'draft',
      }),
    );
    const h = header();
    expect(within(h).getByRole('link', { name: 'PR' })).toHaveAttribute('href', odd);
    expect(h.querySelector('[data-phase="draft"]')).not.toBeNull();
    expect(h.querySelector('[data-ci]')).toBeNull();
  });

  it('shows an unlinked branch as text, saying when it is not pushed yet', async () => {
    await open(detail());
    const h = header();
    expect(within(h).queryByRole('link', { name: branch })).toBeNull();
    expect(must(within(h).getByText(branch).closest('[title]'))).toHaveAttribute(
      'title',
      'into main',
    );
    // Details states the base visibly, for keyboard and touch users; not a GitHub repository, so
    // no push claim.
    openDetails();
    expect(await screen.findByTestId('branch-line')).toHaveTextContent(
      `Branch ${branch} into main`,
    );
    expect(screen.getByTestId('branch-line')).not.toHaveTextContent('not pushed yet');
    cleanup();

    await open(
      detail({
        job: { ...detail().job, repo: 'github.com/x/y' },
        links: { ...detail().links, branchUnpushed: true },
      }),
    );
    expect(within(header()).queryByRole('link', { name: branch })).toBeNull();
    expect(must(within(header()).getByText(branch).closest('[title]'))).toHaveAttribute(
      'title',
      'into main; not pushed yet',
    );
    openDetails();
    expect(await screen.findByTestId('branch-line')).toHaveTextContent(
      `Branch ${branch} into main, not pushed yet`,
    );
    cleanup();

    // Once linked, Details still names the base and claims nothing about pushing.
    await open(delivered());
    openDetails();
    expect(await screen.findByTestId('branch-line')).toHaveTextContent(
      `Branch ${branch} into main`,
    );
    expect(screen.getByTestId('branch-line')).not.toHaveTextContent('not pushed yet');
  });
});

describe('Job detail: controls state their effect', () => {
  /** Hover a control and return its tooltip text, which describes (never names) the button. */
  async function described(name: string) {
    const button = screen.getByRole('button', { name });
    fireEvent.mouseOver(button);
    const tip = await screen.findByRole('tooltip');
    expect(button).toHaveAccessibleName(name);
    expect(button).toHaveAccessibleDescription(tip.textContent);
    const text = tip.textContent;
    fireEvent.mouseLeave(button);
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });
    return text;
  }
  async function dialogEffect(name: string) {
    fireEvent.click(screen.getByRole('button', { name }));
    const dialog = await screen.findByRole('dialog');
    return { dialog, effect: within(dialog).getByTestId('action-effect').textContent };
  }
  async function closeDialog() {
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  }

  it('describes Resume, rework, review, and cancel with the next round, in tooltip and dialog', async () => {
    mockFetch();
    data.detail = detail({ job: { ...detail().job, round: 2, maxRounds: 3 } });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });

    const resume = await described('Resume at approve');
    expect(resume).toContain('Moves the job to approve as pending');
    expect(resume).toContain('fixes nothing and starts no session');
    expect(resume).not.toContain('round');
    const rework = await described('Request rework');
    expect(rework).toContain('builder runs again from build');
    // The human's resume raises maxRounds by one, so the maximum shown is the raised one.
    expect(rework).toContain('review round 3 of 4');
    const review = await described('Request review round');
    expect(review).toContain('reviewers run again on the current build');
    expect(review).toContain('review round 3 of 4');
    const cancel = await described('Cancel job');
    expect(cancel).toContain('Ends the job as cancelled: it cannot be resumed');
    expect(cancel).toContain('worktree and branch are kept');

    // The dialog repeats the effect; Resume's follows the selected stage.
    let { dialog, effect } = await dialogEffect('Resume at approve');
    expect(effect).toBe(resume);
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Resume at stage' }));
    fireEvent.click(await screen.findByRole('option', { name: 'simplify' }));
    expect(within(dialog).getByTestId('action-effect')).toHaveTextContent(
      'Moves the job to simplify as pending, opening review round 3 of 4',
    );
    await closeDialog();

    ({ effect } = await dialogEffect('Request rework'));
    expect(effect).toBe(rework);
    await closeDialog();

    ({ dialog, effect } = await dialogEffect('Cancel job'));
    expect(effect).toBe(cancel);
    expect(dialog).not.toHaveTextContent('returns the job to a pending stage');
    expect(dialog).toHaveTextContent('cannot be undone');
  });

  it('keeps Resume at CI outlined beside the caution on a CI-blocked job', async () => {
    mockFetch();
    data.detail = detail({
      job: { ...detail().job, returnStage: 'ci', ciHead: 'd4e5f60718293041' },
      blocker: { kind: 'ci', summary: 'CI still failing after 1 of 1 repair cycles', detail: null },
      actions: ['approve', 'request-review', 'request-rework', 'accept-delivery', 'cancel'],
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    const approve = screen.getByRole('button', { name: 'Resume at CI' });
    expect(approve.className).toContain('MuiButton-outlined');
    expect(approve.className).not.toContain('MuiButton-contained');
    expect(screen.getByTestId('approve-caution')).toHaveTextContent('not waiting for an approval');
    expect(await described('Resume at CI')).toContain('Moves the job to ci as pending');
    expect(await described('Accept delivery')).toContain(
      'Completes the job without a CI verdict, with your reason recorded as the human close-out; nothing is merged or marked ready.',
    );
  });

  it('describes Merge and Archive as their server messages do', async () => {
    mockFetch();
    data.detail = detail({
      job: { ...detail().job, stage: 'completed', status: 'completed', prState: 'ready' },
      ci: noCi({ head: 'abcdef0123456789' }),
      blocker: null,
      actions: ['merge', 'refresh-pr', 'archive'],
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(await described('Merge')).toContain('Merges the PR at abcdef0 as a merge commit');
    expect(await described('Archive')).toContain(
      'Hides the job from the board unless Show is set to archived',
    );
    const { effect } = await dialogEffect('Archive');
    expect(effect).toContain('Hides the job from the board');
  });
});

describe('Job detail: execution session', () => {
  const link = 'agent-host-session://ahp-session/17b6e18f-4046-422b-8336-cb43a130967f';
  const uuid = '565e2b23-152d-4533-b6b3-e1d4981c7297';

  it('says so when no session was recorded', async () => {
    window.location.hash = '#/jobs/job-00000003';
    mockFetch();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByTestId('session-none')).not.toBeInTheDocument();
    openDetails();
    expect(await screen.findByTestId('session-none')).toHaveTextContent('No execution session');
  });

  it('offers an in-VS-Code link for copying, never as a dead browser control', async () => {
    data.detail = detail({
      session: {
        provider: 'vscode-agents',
        ref: link,
        cwd: '/wt/g',
        attachedAt: '2026-11-13T08:20:00.000Z',
        by: 'claude-parent',
        links: {
          open: { url: link, scope: 'vscode-chat' },
          resume: null,
          note: 'Opens from inside VS Code only.',
        },
        previous: 1,
      },
    });
    window.location.hash = '#/jobs/job-00000003';
    mockFetch();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    openDetails();
    await screen.findByTestId('session');
    const s = screen.getByTestId('session');
    expect(s).toHaveTextContent('vscode-agents');
    expect(s).toHaveTextContent(link);
    expect(s).toHaveTextContent('by claude-parent');
    expect(s).toHaveTextContent('1 earlier attachment');
    expect(s).toHaveTextContent('Opens from inside VS Code only.');
    expect(within(s).queryByRole('link')).toBeNull();
    expect(within(s).getByRole('button', { name: 'Copy session link' })).toBeInTheDocument();
  });

  it('gives a claude-code session its VS Code link and resume command', async () => {
    data.detail = detail({
      session: {
        provider: 'claude-code',
        ref: uuid,
        cwd: null,
        attachedAt: '2026-11-13T08:20:00.000Z',
        by: null,
        links: {
          open: { url: `vscode://anthropic.claude-code/open?session=${uuid}`, scope: 'os' },
          resume: `claude --resume ${uuid}`,
          note: 'The VS Code link resumes the session.',
        },
        previous: 0,
      },
    });
    window.location.hash = '#/jobs/job-00000003';
    mockFetch();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    openDetails();
    await screen.findByTestId('session');
    const s = screen.getByTestId('session');
    expect(within(s).getByRole('link', { name: 'Open session in VS Code' })).toHaveAttribute(
      'href',
      `vscode://anthropic.claude-code/open?session=${uuid}`,
    );
    expect(s).toHaveTextContent(`claude --resume ${uuid}`);
    expect(s).not.toHaveTextContent('earlier attachment');
  });
});

describe('Job detail: status panel and escalation', () => {
  const decisionMd = `# Decision: Gamma

## Examined

spec.md, build.md, the diff.

## Scope changes

The logging format changed.

## Rationale

AC2 needs a deployment to verify; a human should decide.

DECISION: ESCALATE
`;
  const decisionRow = {
    id: 7,
    jobId: 'job-00000003',
    stage: 'approve',
    round: null,
    path: 'decision.md',
    bytes: decisionMd.length,
    sha256: null,
    marker: 'escalate',
    head: null,
    specSha256: null,
    createdAt: '2026-11-13T08:20:00.000Z',
  } satisfies JobDetailView['artifacts'][number];
  const consolidated = (marker: number) => `# Consolidated findings (round 2)

## Findings

1. [BLOCKING] a.ts:1 — quotes are not escaped → escape them
2. [MAJOR] a.ts:9 — buffers everything → stream
3. [BLOCKING] b.ts:4 — no backpressure → add it
4. [MINOR] c.ts:2 — naming → rename

## Dropped

- [BLOCKING] dropped.ts:1 — out of scope

BLOCKING: ${String(marker)}
`;
  const withRounds = (marker: number) =>
    detail({
      artifacts: [decisionRow],
      contents: {
        'decision.md': decisionMd,
        'round-1/consolidated.md': consolidated(5),
        'round-2/consolidated.md': consolidated(marker),
      },
      rounds: [
        { round: 1, reviews: [], consolidated: 'round-1/consolidated.md', blocking: 5 },
        { round: 2, reviews: [], consolidated: 'round-2/consolidated.md', blocking: marker },
        { round: 3, reviews: [], consolidated: null, blocking: null },
      ],
    });

  it('shows the approver decision and the newest blocking findings above Controls', async () => {
    mockFetch();
    data.detail = withRounds(2);
    window.location.hash = '#/jobs/job-00000003';
    mount();
    const decision = await screen.findByTestId('decision-summary');
    expect(decision).toHaveTextContent('DECISION: ESCALATE');
    expect(decision).toHaveTextContent('AC2 needs a deployment to verify; a human should decide.');
    expect(decision).not.toHaveTextContent('Examined');
    expect(decision).not.toHaveTextContent('Scope changes');
    expect(decision).not.toHaveTextContent('logging format');
    const controls = screen.getByText('Controls');
    expect(decision.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const findings = screen.getByTestId('blocking-findings');
    expect(findings).toHaveTextContent('Round 2: 2 blocking finding(s)');
    const items = within(findings).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      '[BLOCKING] a.ts:1 — quotes are not escaped → escape them',
      '[BLOCKING] b.ts:4 — no backpressure → add it',
    ]);
    expect(findings.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('trusts the BLOCKING marker over tagged lines, and says when nothing is consolidated', async () => {
    mockFetch();
    data.detail = withRounds(0);
    window.location.hash = '#/jobs/job-00000003';
    mount();
    const findings = await screen.findByTestId('blocking-findings');
    expect(findings).toHaveTextContent('Round 2: no blocking findings.');
    expect(within(findings).queryAllByRole('listitem')).toHaveLength(0);
    cleanup();

    data.detail = detail({ contents: {}, rounds: [] });
    mount();
    expect(await screen.findByTestId('blocking-findings')).toHaveTextContent(
      'No consolidated findings yet.',
    );
    expect(screen.getByTestId('decision-summary')).toHaveTextContent(
      'No approver decision recorded.',
    );
  });

  it('renders neither block away from needs-human', async () => {
    mockFetch();
    const base = withRounds(2);
    data.detail = {
      ...base,
      job: { ...base.job, stage: 'review', status: 'running', ownerSession: 'claude-9' },
      liveness: 'running',
      blocker: null,
      actions: ['cancel'],
      resume: {
        command: null,
        heldBy: { session: 'claude-9', leaseExpiresAt: '2999-01-01T00:00:00.000Z' },
      },
    };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    // A live lease: the next line names the holder.
    expect(await screen.findByTestId('status-next')).toHaveTextContent(
      'Continue from, or wait for, session claude-9.',
    );
    expect(screen.queryByTestId('decision-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('blocking-findings')).not.toBeInTheDocument();
  });

  it('keeps Equivalent CLI and the checkout in a collapsed Details, and the next line per kind', async () => {
    mockFetch();
    data.detail = detail({
      blocker: { kind: 'verification', summary: 'Verification failed at abc1234', detail: null },
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    expect(await screen.findByTestId('status-next')).toHaveTextContent(
      'Request rework to fix the failing check, or resume to run it again.',
    );
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Equivalent CLI/)).not.toBeInTheDocument();
    openDetails();
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText(/Equivalent CLI/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open checkout in VS Code' })).toBeVisible();
  });

  it('never repeats the plan blocked reason as an Overview alert', async () => {
    mockFetch();
    data.detail = detail({
      plan: {
        step: 'blocked',
        reason: 'needs a human',
        agents: [],
        artifacts: [],
        blockedReason: 'AC2 needs deployment verification',
        worktree: null,
      } as unknown as JobDetailView['plan'],
      planError: null,
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByText(/Next step:/);
    expect(screen.queryByText(/^Blocked:/)).not.toBeInTheDocument();
    expect(
      screen.queryAllByRole('alert').filter((a) => a.textContent.startsWith('Blocked:')),
    ).toHaveLength(0);
  });

  it('shows a run queued for the machine-wide verify lock on the Verification tab', async () => {
    mockFetch();
    data.detail = detail({
      plan: {
        step: 'run-agent',
        reason: 'build',
        agents: [],
        artifacts: [],
        worktree: null,
        verification: {
          configured: true,
          policy: {
            source: 'baseline',
            head: 'abc1234567',
            fingerprint: 'fp',
            checks: ['check'],
            authorization: 'not-needed',
            candidateError: null,
          },
          run: null,
          valid: false,
          reason: 'no verification run recorded',
          queue: {
            state: 'queued',
            since: '2026-11-18T01:00:00.000Z',
            holderJobId: 'job-0000000a',
            ahead: 1,
          },
        },
        sensitive: null,
        integration: null,
      } as unknown as JobDetailView['plan'],
      planError: null,
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'Verification' }));
    expect(await screen.findByTestId('verify-queue')).toHaveTextContent(
      /Queued for verification behind job-0000000a since .+ \(1 ahead\)/,
    );
  });
});

describe('Archive', () => {
  const archivedRow = row({
    id: 'job-00000009',
    title: 'Omega archived',
    status: 'completed',
    liveness: 'completed',
    stage: 'completed',
    owner: null,
    archivedAt: '2026-11-14T00:00:00.000Z',
  });

  async function show(filter: string) {
    await choose('Show', new RegExp(`^${filter} [(][0-9]+[)]$`));
  }

  it('hides archived jobs from every view except Show: archived', async () => {
    data.rows = [...rows, archivedRow];
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(screen.queryByText('Omega archived')).not.toBeInTheDocument();
    for (const f of ['finished', 'cancelled']) {
      await show(f);
      await waitFor(() => {
        expect(screen.getByRole('combobox', { name: 'Show' })).toHaveDisplayValue(
          new RegExp(`^${f} [(]`),
        );
      });
      expect(screen.queryByText('Omega archived')).not.toBeInTheDocument();
    }
    await show('archived');
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(2);
    });
    const shown = must(document.querySelector<HTMLElement>('[data-job-id="job-00000009"]'));
    expect(within(shown).getByText('Omega archived')).toBeInTheDocument();
    expect(within(shown).getByText('archived')).toBeInTheDocument();
  });

  it('says nothing matches instead of "No jobs yet" under Show: archived', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    await show('archived');
    expect(await screen.findByText('No jobs match these filters.')).toBeInTheDocument();
    expect(screen.queryByText(/No jobs yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
  });

  it('offers Archive and Unarchive only when the server lists them, and posts the action', async () => {
    const f = mockFetch();
    const base = detail();
    const finished = {
      ...base.job,
      stage: 'completed' as const,
      status: 'completed' as const,
      completedAt: base.job.updatedAt,
    };
    data.detail = detail({
      job: finished,
      liveness: 'completed',
      blocker: null,
      actions: ['archive'],
      resume: null,
    });
    data.actionBody = {
      job: { ...finished, archivedAt: '2026-11-15T00:00:00.000Z' },
      message: 'Job archived: hidden from the board unless Show is set to archived.',
    };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('button', { name: 'Unarchive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog');
    // A plain confirm: no reason field and no takeover checkbox.
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Job archived');
    });
    const posts = () =>
      (f.mock.calls as [RequestInfo | URL, RequestInit | undefined][])
        .filter(([, i]) => i?.method === 'POST')
        .map(([, i]) => JSON.parse(i?.body as string) as unknown);
    expect(posts()).toEqual([{ action: 'archive', force: true }]);
    cleanup();

    f.mockClear();
    data.detail = detail({
      job: { ...finished, archivedAt: '2026-11-15T00:00:00.000Z' },
      liveness: 'completed',
      blocker: null,
      actions: ['unarchive'],
      resume: null,
    });
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText('archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    const again = await screen.findByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => {
      expect(posts()).toEqual([{ action: 'unarchive', force: true }]);
    });
    cleanup();

    // An active job never gets either button.
    data.detail = detail();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByRole('button', { name: 'Cancel job' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unarchive' })).not.toBeInTheDocument();
  });
});

describe('Board grid: columns, sort, filter, row archive', () => {
  const headers = () =>
    within(screen.getByRole('table', { name: 'Factory jobs' }))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
  const ids = () =>
    [...document.querySelectorAll<HTMLElement>('[data-job-id]')].map((r) => r.dataset['jobId']);
  const posts = (f: FetchMock) =>
    (f.mock.calls as [string, RequestInit | undefined][])
      .filter(([, i]) => i?.method === 'POST')
      .map(([u, i]) => [u, JSON.parse(i?.body as string) as unknown]);
  async function show(filter: string) {
    await choose('Show', new RegExp(`^${filter} [(][0-9]+[)]$`));
  }

  it('hides Repository, Session, and Branch by default; the Columns menu toggles and remembers', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(headers()).not.toContain('Repository');
    expect(headers()).not.toContain('Session');
    expect(headers()).not.toContain('Branch / worktree');
    expect(headers()).toEqual(expect.arrayContaining(['Job', 'Status', 'Stage', 'Actions']));
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('checkbox')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Repository column',
      'Stage column',
      'Session column',
      'Branch / worktree column',
      'Round column',
      'Reviews column',
      'Elapsed column',
      'Started column',
      'Updated column',
      'PR / CI column',
    ]);
    expect(within(menu).getByRole('checkbox', { name: 'Session column' })).not.toBeChecked();
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Session column' }));
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Stage column' }));
    expect(within(menu).getByRole('checkbox', { name: 'Session column' })).toBeChecked();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(headers()).toContain('Session');
    expect(headers()).not.toContain('Stage');
    expect(screen.getAllByText('claude-1').length).toBeGreaterThan(0);
    cleanup();
    // Remounting reads the saved choice.
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(headers()).toContain('Session');
    expect(headers()).not.toContain('Stage');
    expect(headers()).not.toContain('Repository');
  });

  it('sorts by a header click, ascending then descending, and by attention until then', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    // Needs human, then stale, then running, then finished.
    expect(ids()).toEqual(['job-00000003', 'job-00000002', 'job-00000001', 'job-00000004']);
    expect(headers()).not.toContain('Blocking');
    const header = (name: string) =>
      must(screen.getByRole('button', { name }).closest<HTMLElement>('th'));
    // Reviews sorts by the blocking count it now carries.
    fireEvent.click(screen.getByRole('button', { name: 'Reviews' }));
    expect(header('Reviews')).toHaveAttribute('aria-sort', 'ascending');
    expect(ids().at(-1)).toBe('job-00000002');
    fireEvent.click(screen.getByRole('button', { name: 'Reviews' }));
    expect(header('Reviews')).toHaveAttribute('aria-sort', 'descending');
    expect(ids()[0]).toBe('job-00000002');
    fireEvent.click(screen.getByRole('button', { name: 'Job' }));
    expect(header('Job')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Reviews')).not.toHaveAttribute('aria-sort');
    expect(ids()).toEqual(['job-00000001', 'job-00000002', 'job-00000004', 'job-00000003']);
    fireEvent.click(screen.getByRole('button', { name: 'Job' }));
    expect(ids()).toEqual(['job-00000003', 'job-00000004', 'job-00000002', 'job-00000001']);
    // Stage sorts by workflow position (Build, Build, Review, CI), not by the stage string.
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
    expect(ids()).toEqual(['job-00000001', 'job-00000004', 'job-00000002', 'job-00000003']);
    fireEvent.click(screen.getByRole('button', { name: 'Stage' }));
    expect(ids()).toEqual(['job-00000003', 'job-00000002', 'job-00000001', 'job-00000004']);
    fireEvent.click(screen.getByRole('button', { name: 'Job' }));
    for (const name of ['Stage', 'Status', 'Round', 'Elapsed', 'Started', 'Updated']) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(header(name)).toHaveAttribute('aria-sort', 'ascending');
    }
  });

  it('filters by text, combined with the Show and Repository selects', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    const filter = screen.getByRole('searchbox', { name: 'Filter' });
    fireEvent.change(filter, { target: { value: 'gamma' } });
    expect(ids()).toEqual(['job-00000003', 'job-00000004']);
    fireEvent.change(filter, { target: { value: 'job-00000002' } });
    expect(ids()).toEqual(['job-00000002']);
    fireEvent.change(filter, { target: { value: 'gamma' } });
    await show('cancelled');
    await waitFor(() => {
      expect(ids()).toEqual(['job-00000004']);
    });
    fireEvent.change(filter, { target: { value: '' } });
    await show('current');
    await waitFor(() => {
      expect(ids()).toHaveLength(4);
    });
    // The Repository select narrows server-side; the text filter applies on top.
    data.rows = rows.filter((r) => r.repo === 'gamma');
    await choose('Repository', 'gamma');
    fireEvent.change(filter, { target: { value: 'delta' } });
    await waitFor(() => {
      expect(ids()).toEqual(['job-00000004']);
    });
  });

  it('labels each job with its repository when the board spans several, Repository column hidden', async () => {
    data.rows = [
      row({ id: 'job-000000a1', title: 'Same title', repo: 'github.com/acme/alpha' }),
      row({ id: 'job-000000b1', title: 'Same title', repo: 'github.com/acme/beta' }),
    ];
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    expect(headers()).not.toContain('Repository');
    const at = (id: string) => must(table.querySelector<HTMLElement>(`[data-job-id="${id}"]`));
    // The label's accessible name (and hover) is the full identity.
    expect(within(at('job-000000a1')).getByText('alpha')).toHaveAttribute(
      'aria-label',
      'github.com/acme/alpha',
    );
    expect(within(at('job-000000b1')).getByText('beta')).toBeInTheDocument();
    expect(within(at('job-000000a1')).queryByText('beta')).not.toBeInTheDocument();
    expect(within(at('job-000000b1')).queryByText('alpha')).not.toBeInTheDocument();
    // The id stays in the caption.
    expect(within(at('job-000000a1')).getByText(/job-000000a1/)).toBeInTheDocument();
    // Showing the Repository column leaves the caption label in place.
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Repository column' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(headers()).toContain('Repository');
    expect(within(at('job-000000b1')).getByText('beta')).toBeInTheDocument();
  });

  it('drops the repository label when every row comes from one repository', async () => {
    data.rows = [row({ id: 'job-000000a1' }), row({ id: 'job-000000a2' })];
    mockFetch();
    const view = mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(document.querySelectorAll('[data-repo-label]')).toHaveLength(0);
    expect(screen.getByText('job-000000a2')).toBeInTheDocument();
    view.unmount();
    // Several repositories label every row; narrowing to one removes the now-redundant label.
    data.rows = rows;
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(document.querySelectorAll('[data-repo-label]')).toHaveLength(4);
    data.rows = rows.filter((r) => r.repo === 'gamma');
    await choose('Repository', 'gamma');
    await waitFor(() => {
      expect(ids()).toEqual(['job-00000003', 'job-00000004']);
    });
    expect(document.querySelectorAll('[data-repo-label]')).toHaveLength(0);
    expect(screen.getByText('job-00000003')).toBeInTheDocument();
  });

  it('offers Archive only on finished rows and posts it, with takeover only when checked', async () => {
    const done = row({
      id: 'job-0000000a',
      title: 'Done job',
      stage: 'completed',
      status: 'completed',
      liveness: 'completed',
    });
    const failed = row({
      id: 'job-0000000b',
      title: 'Failed',
      status: 'failed',
      liveness: 'failed',
    });
    data.rows = [...rows, done, failed];
    data.actionBody = { job: detail().job, message: 'Job archived' };
    const f = mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    const archiveIn = (id: string) => {
      const r = must(document.querySelector<HTMLElement>(`[data-job-id="${id}"]`));
      // Each row's button names its job, so a screen reader can tell them apart.
      return within(r).queryByRole('button', { name: new RegExp(`^Archive .+ [(]${id}[)]$`) });
    };
    for (const id of ['job-00000001', 'job-00000002', 'job-00000003', 'job-0000000b']) {
      expect(archiveIn(id)).toBeNull();
    }
    expect(archiveIn('job-00000004')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Archive Done job (job-0000000a)' })).toBe(
      archiveIn('job-0000000a'),
    );
    // A plain confirm: no reason field, no takeover checkbox; Cancel posts nothing.
    fireEvent.click(must(archiveIn('job-0000000a')));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(posts(f)).toEqual([]);
    // Archive always takes over any lease a session holds on the finished job.
    fireEvent.click(must(archiveIn('job-0000000a')));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(posts(f)).toEqual([
        ['/api/jobs/job-0000000a/actions', { action: 'archive', force: true }],
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // The row may leave the view, so focus moves to the Columns button, not to the page body.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Columns' })).toHaveFocus();
    });
    // A refusal shows in the dialog.
    data.actionStatus = 409;
    data.actionBody = { error: { type: 'OwnershipError', message: 'held by claude-9' } };
    fireEvent.click(must(archiveIn('job-00000004')));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await within(dialog).findByText('OwnershipError: held by claude-9')).toBeInTheDocument();
  });

  it('Show: archived lists Unarchive on each row; after it the row returns to current', async () => {
    const archived = row({
      id: 'job-00000009',
      title: 'Omega archived',
      stage: 'completed',
      status: 'completed',
      liveness: 'completed',
      owner: null,
      archivedAt: '2026-11-14T00:00:00.000Z',
    });
    data.rows = [...rows, archived];
    data.actionBody = { job: detail().job, message: 'Job unarchived' };
    const f = mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(screen.queryByRole('button', { name: /^Unarchive / })).not.toBeInTheDocument();
    await show('archived');
    await waitFor(() => {
      expect(ids()).toEqual(['job-00000009']);
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Unarchive Omega archived (job-00000009)' }),
    );
    const dialog = await screen.findByRole('dialog');
    data.rows = [...rows, { ...archived, archivedAt: null }];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => {
      expect(posts(f)).toEqual([
        ['/api/jobs/job-00000009/actions', { action: 'unarchive', force: true }],
      ]);
    });
    await waitFor(() => {
      expect(ids()).toEqual([]);
    });
    // Jobs exist but none match: say so, and keep the Columns button (and focus on it).
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No jobs match these filters.');
    });
    expect(screen.getByRole('button', { name: 'Columns' })).toHaveFocus();
    await show('current');
    await waitFor(() => {
      expect(ids()).toContain('job-00000009');
    });
  });

  const boardRow = (id: string) =>
    must(document.querySelector<HTMLElement>(`[data-job-id="${id}"]`));

  it('a click on a plain cell, or Enter on the focused row, opens that job', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    // The title stays a real anchor, so middle-click and open-in-new-tab keep working.
    expect(screen.getByRole('link', { name: 'Gamma blocked' })).toHaveAttribute(
      'href',
      '#/jobs/job-00000003',
    );
    fireEvent.click(within(boardRow('job-00000003')).getByText('30m'));
    expect(window.location.hash).toBe('#/jobs/job-00000003');
    await screen.findByRole('heading', { name: 'Gamma blocked' });

    window.location.hash = '';
    await screen.findByRole('table', { name: 'Factory jobs' });
    const r = boardRow('job-00000002');
    expect(r).toHaveAttribute('tabindex', '0');
    r.focus();
    expect(r).toHaveFocus();
    fireEvent.keyDown(r, { key: 'Enter' });
    expect(window.location.hash).toBe('#/jobs/job-00000002');
  });

  it('inner buttons, chips, and links act on their own and never open the row', async () => {
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    data.rows = [
      ...rows,
      row({ id: 'job-00000006', title: 'Old', status: 'cancelled', liveness: 'cancelled' }),
      row({
        id: 'job-00000007',
        title: 'Replaced',
        status: 'cancelled',
        liveness: 'cancelled',
        supersededBy: 'job-00000006',
      }),
    ];
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });

    // Archive opens its confirm dialog, not the job; Enter on it does not open the row either.
    const archive = within(boardRow('job-00000004')).getByRole('button', { name: /^Archive / });
    fireEvent.keyDown(archive, { key: 'Enter' });
    fireEvent.click(archive);
    const dialog = await screen.findByRole('dialog');
    expect(window.location.hash).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(window.location.hash).toBe('');

    // Copy resume copies (and shows its snackbar) without navigating.
    fireEvent.click(
      within(boardRow('job-00000003')).getByRole('button', {
        name: 'Copy resume command for job-00000003',
      }),
    );
    await waitFor(() => {
      expect(write).toHaveBeenCalledWith('/factory resume job-00000003');
    });
    expect(window.location.hash).toBe('');

    // The PR link keeps its own target and href and does not open the row.
    const pr = within(boardRow('job-00000003')).getByRole('link', { name: 'PR #1' });
    expect(pr).toHaveAttribute('target', '_blank');
    expect(pr).toHaveAttribute('href', 'https://github.com/x/y/pull/1');
    fireEvent.click(pr);
    expect(window.location.hash).not.toBe('#/jobs/job-00000003');

    // Enter on the focusable Reviews chip does not open the row.
    const chip = must(
      within(boardRow('job-00000002'))
        .getByText('1/2, 1 pending')
        .closest<HTMLElement>('[tabindex]'),
    );
    expect(chip).not.toBe(boardRow('job-00000002'));
    chip.focus();
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(window.location.hash).not.toBe('#/jobs/job-00000002');

    // A supersession link lands on the other job, not this row's.
    fireEvent.click(within(boardRow('job-00000007')).getByRole('link', { name: 'job-00000006' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/jobs/job-00000006');
    });
  });
});

describe('Job detail: reviews', () => {
  it('collapses each reviewer by default, keeping name, verdict, and summary visible', async () => {
    const review = {
      jobId: 'job-00000003',
      round: 1,
      artifactId: 1,
      head: 'abc',
      model: null,
      sameAsAuthor: null,
      createdAt: '2026-11-13T08:10:00.000Z',
      completedAt: '2026-11-13T08:20:00.000Z',
    };
    data.detail = detail({
      models: { builder: { model: 'opus' }, security: { model: 'fable', sameAsAuthor: false } },
      contents: {
        'round-1/security.md': '# Security\n\nSecurity body text\n\nVERDICT: PASS\n',
        'round-1/correctness.md': '# Correctness\n\nCorrectness body text\n\nVERDICT: CHANGES\n',
      },
      rounds: [
        {
          round: 1,
          reviews: [
            {
              ...review,
              id: 1,
              reviewer: 'security',
              verdict: 'pass',
              summary: 'No issues',
              path: 'round-1/security.md',
              model: 'opus',
              sameAsAuthor: true,
            },
            {
              ...review,
              id: 2,
              reviewer: 'correctness',
              verdict: 'changes',
              summary: 'One bug',
              path: 'round-1/correctness.md',
            },
          ],
          consolidated: null,
          blocking: 1,
        },
      ],
    });
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    // Ticket 0168: the job's drawn models, and each review's model and flag.
    expect(screen.getByTestId('drawn-models')).toHaveTextContent(
      'Models drawn: builder opus, security fable (same as author: no)',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Reviews (1 round)' }));
    expect(screen.getByText('blocking 1')).toBeInTheDocument();
    expect(screen.getByText('opus (same as author: yes)')).toBeInTheDocument();
    expect(
      screen.getByText('model not recorded (same as author: not recorded)'),
    ).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /security.*pass.*No issues/ });
    const other = screen.getByRole('button', { name: /correctness.*changes.*One bug/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(other).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Security body text')).not.toBeInTheDocument();
    expect(screen.queryByText('Correctness body text')).not.toBeInTheDocument();
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Security body text')).toBeVisible();
    // Expanding one reviewer leaves the others collapsed.
    expect(other).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Correctness body text')).not.toBeInTheDocument();
    // aria-controls names only a mounted region: absent while collapsed, unique while expanded.
    expect(other).not.toHaveAttribute('aria-controls');
    const controls = must(header.getAttribute('aria-controls'));
    expect(document.querySelectorAll(`[id="${controls}"]`)).toHaveLength(1);
    expect(must(document.getElementById(controls))).toHaveTextContent('Security body text');
    fireEvent.click(header);
    await waitFor(() => {
      expect(header).not.toHaveAttribute('aria-controls');
    });
  });

  it('marks the round equal to job.round as current and keeps earlier rounds listed', async () => {
    const review = {
      jobId: 'job-00000003',
      artifactId: 1,
      head: 'abc',
      model: null,
      sameAsAuthor: null,
      summary: null,
      createdAt: '2026-11-13T08:10:00.000Z',
      completedAt: '2026-11-13T08:20:00.000Z',
    };
    const base = detail();
    data.detail = detail({
      job: { ...base.job, round: 2 },
      rounds: [
        {
          round: 1,
          reviews: [
            {
              ...review,
              id: 1,
              round: 1,
              reviewer: 'correctness',
              verdict: 'changes',
              path: 'round-1/review-correctness.md',
            },
          ],
          consolidated: null,
          blocking: 2,
        },
        {
          round: 2,
          reviews: [
            {
              ...review,
              id: 2,
              round: 2,
              reviewer: 'correctness',
              verdict: 'pass',
              path: 'round-2/review-correctness.md',
            },
          ],
          consolidated: null,
          blocking: null,
        },
      ],
    });
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('tab', { name: 'Reviews (2 rounds)' }));
    expect(screen.getByRole('heading', { name: /^Round 2 \(current\)/ })).toBeInTheDocument();
    const old = screen.getByRole('heading', { name: /^Round 1/ });
    expect(old).not.toHaveTextContent('current');
    // History: round 1's CHANGES is still listed beside round 2's PASS.
    expect(screen.getByRole('button', { name: /correctness.*changes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /correctness.*pass/ })).toBeInTheDocument();
  });

  it('expands and collapses one round at a time, with a standard expand icon (ticket 0028)', async () => {
    const review = (id: number, round: number, reviewer: string) => ({
      jobId: 'job-00000003',
      artifactId: 1,
      head: 'abc',
      model: null,
      sameAsAuthor: null,
      summary: null,
      createdAt: '2026-11-13T08:10:00.000Z',
      completedAt: '2026-11-13T08:20:00.000Z',
      id,
      round,
      reviewer,
      verdict: 'pass' as const,
      path: null,
    });
    const base = detail();
    data.detail = detail({
      job: { ...base.job, round: 3 },
      rounds: [
        {
          round: 1,
          reviews: [review(1, 1, 'alpha'), review(2, 1, 'beta')],
          consolidated: null,
          blocking: 0,
        },
        {
          round: 2,
          reviews: [review(3, 2, 'gamma'), review(4, 2, 'delta')],
          consolidated: null,
          blocking: null,
        },
        { round: 3, reviews: [], consolidated: null, blocking: null },
      ],
    });
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('tab', { name: 'Reviews (3 rounds)' }));
    const button = (name: string) => screen.getByRole('button', { name });
    const header = (reviewer: string) => screen.getByRole('button', { name: new RegExp(reviewer) });
    const expanded = (reviewer: string, value: 'true' | 'false') => {
      expect(header(reviewer)).toHaveAttribute('aria-expanded', value);
    };

    // One pair per round with reviewers, none for the empty round, none inside a heading.
    for (const n of [1, 2]) {
      expect(button(`Expand all round ${String(n)}`)).toBeEnabled();
      expect(button(`Collapse all round ${String(n)}`)).toBeDisabled();
    }
    expect(screen.getByText('No reviewers recorded.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand all round 3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse all round 3' })).not.toBeInTheDocument();
    expect(button('Expand all round 2').closest('h1,h2,h3,h4,h5,h6,[role="heading"]')).toBeNull();
    expect(button('Expand all round 2').closest('.MuiAccordionSummary-root')).toBeNull();

    // The expand control is an icon, not the text arrow.
    expect(header('alpha').querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(header('alpha')).not.toHaveTextContent('▾');

    // A panel opened by hand in round 1 survives round 2's buttons; round 1 is now mixed.
    fireEvent.click(header('alpha'));
    expect(button('Expand all round 1')).toBeEnabled();
    expect(button('Collapse all round 1')).toBeEnabled();

    fireEvent.click(button('Expand all round 2'));
    expanded('gamma', 'true');
    expanded('delta', 'true');
    expanded('alpha', 'true');
    expanded('beta', 'false');
    expect(button('Expand all round 2')).toBeDisabled();
    expect(button('Collapse all round 2')).toBeEnabled();

    // One header still toggles only its own panel.
    fireEvent.click(header('gamma'));
    expanded('gamma', 'false');
    expanded('delta', 'true');
    expect(button('Expand all round 2')).toBeEnabled();
    expect(button('Collapse all round 2')).toBeEnabled();

    fireEvent.click(button('Collapse all round 2'));
    expanded('gamma', 'false');
    expanded('delta', 'false');
    expanded('alpha', 'true');
    expect(button('Collapse all round 2')).toBeDisabled();
  });

  it('draws the Details expander with the same icon (ticket 0028)', async () => {
    data.detail = detail();
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(
      screen.getByRole('button', { name: 'Details' }).querySelector('svg[aria-hidden="true"]'),
    ).not.toBeNull();
  });
});

describe('PR phase, Merge, and Refresh PR', () => {
  const pr = 'https://github.com/x/y/pull/1';
  const head = 'abcdef0123456789';
  function readyDetail(over: Partial<JobDetailView> = {}): JobDetailView {
    const base = detail();
    return detail({
      job: {
        ...base.job,
        stage: 'completed',
        status: 'completed',
        completedAt: base.job.updatedAt,
        prUrl: pr,
        prState: 'ready',
        ciStatus: 'passing',
        ciHead: head,
      },
      liveness: 'completed',
      blocker: null,
      resume: null,
      ci: noCi({ status: 'passing', head, completion: 'ci' }),
      prPhase: 'ready-to-merge',
      actions: ['merge', 'refresh-pr', 'archive'],
      ...over,
    });
  }
  const posts = (f: FetchMock) =>
    (f.mock.calls as [RequestInfo | URL, RequestInit | undefined][])
      .filter(([, i]) => i?.method === 'POST')
      .map(([, i]) => JSON.parse(i?.body as string) as unknown);

  it('shows the phase chip with a text label on the board, unless the CI chip states it', async () => {
    mockFetch();
    const failing = must(data.rows.find((r) => r.pr.phase === 'ci-failing'));
    data.rows = [
      failing,
      {
        ...failing,
        id: 'job-00000009',
        title: 'Ready row',
        pr: { ...failing.pr, state: 'ready', phase: 'ready-to-merge', refreshable: false },
        ci: { ...failing.ci, status: 'passing', completion: 'ci' },
      },
    ];
    mount();
    await screen.findByText('Ready row');
    const table = screen.getByRole('table', { name: 'Factory jobs' });
    // CI failing is said once, by the CI chip with its head.
    expect(within(table).getAllByText(/CI failing/)).toHaveLength(1);
    expect(document.querySelector('[data-phase="ci-failing"]')).toBeNull();
    const chip = must(document.querySelector('[data-phase="ready-to-merge"]'));
    expect(chip).toHaveTextContent('ready to merge');
    // The glyph repeats the label, so it is hidden from assistive technology.
    expect(must(chip.querySelector('[aria-hidden="true"]'))).toHaveTextContent('✓');
    // Refresh PR is not allowed for the row, so the chip stays a label.
    expect(chip).not.toHaveAttribute('role', 'button');
    expect(within(table).queryByRole('button', { name: /ready to merge/ })).toBeNull();
  });

  describe('board phase chip runs Refresh PR where the server allows it', () => {
    const refreshRows = () => [
      row({
        id: 'job-00000021',
        title: 'Finished ready',
        stage: 'completed',
        status: 'completed',
        liveness: 'completed',
        owner: null,
        pr: { url: pr, state: 'ready', phase: 'ready-to-merge', refreshable: true },
        ci: noCi({ status: 'passing', head, completion: 'ci' }),
      }),
      row({
        id: 'job-00000022',
        title: 'Waiting on a human',
        stage: 'needs-human',
        status: 'blocked',
        liveness: 'blocked',
        pr: { url: pr, state: 'draft', phase: 'draft', refreshable: true },
      }),
    ];
    const chipOf = (id: string) =>
      within(boardRowOf(id)).getByRole('button', { name: /ready to merge|draft/ });
    const boardReads = (f: FetchMock) =>
      (f.mock.calls as [string, RequestInit | undefined][]).filter(
        ([u, i]) => i?.method !== 'POST' && /^\/api\/jobs(\?|$)/.test(u),
      ).length;

    it('is a focusable button that posts refresh-pr (force only when finished) and reloads', async () => {
      const f = mockFetch();
      data.rows = refreshRows();
      data.actionBody = { job: detail().job, message: `GitHub reports ${pr} as ready.` };
      mount(60_000);
      await screen.findByText('Finished ready');
      const done = chipOf('job-00000021');
      expect(done).toHaveAttribute('tabindex', '0');
      expect(done).toHaveAccessibleDescription(/refresh the PR state from GitHub/);
      expect(done).toHaveAttribute('data-phase', 'ready-to-merge');
      const reads = boardReads(f);
      fireEvent.click(done);
      await waitFor(() => {
        expect(boardReads(f)).toBeGreaterThan(reads);
      });
      expect(window.location.hash).toBe('');
      fireEvent.keyDown(chipOf('job-00000022'), { key: 'Enter' });
      await waitFor(() => {
        expect(posts(f)).toHaveLength(2);
      });
      expect(posts(f)).toEqual([{ action: 'refresh-pr', force: true }, { action: 'refresh-pr' }]);
      expect(window.location.hash).toBe('');
    });

    it('shows a refused refresh on the board and leaves the chip usable', async () => {
      const f = mockFetch();
      data.rows = refreshRows();
      data.actionStatus = 409;
      data.actionBody = { error: { type: 'OwnershipError', message: 'held by another session' } };
      mount(60_000);
      await screen.findByText('Finished ready');
      fireEvent.click(chipOf('job-00000021'));
      expect(await within(boardRowOf('job-00000021')).findByRole('alert')).toHaveTextContent(
        'OwnershipError: held by another session',
      );
      expect(chipOf('job-00000021')).not.toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(chipOf('job-00000021'));
      await waitFor(() => {
        expect(posts(f)).toHaveLength(2);
      });
    });
  });

  it('links the PR by number beside the phase chip, and shows a dash without a PR (ticket 0022)', async () => {
    mockFetch();
    data.rows = [
      row({
        id: 'job-00000021',
        title: 'Merged',
        pr: {
          url: 'https://github.com/x/y/pull/36',
          state: 'merged',
          phase: 'merged',
          refreshable: false,
        },
      }),
      row({
        id: 'job-00000022',
        title: 'Draft',
        pr: {
          url: 'https://github.com/x/y/pull/53/',
          state: 'draft',
          phase: 'draft',
          refreshable: false,
        },
      }),
      row({
        id: 'job-00000023',
        title: 'Odd URL',
        pr: { url: 'https://example.test/pr', state: 'draft', phase: 'draft', refreshable: false },
      }),
      row({ id: 'job-00000024', title: 'No PR yet' }),
    ];
    mount();
    await screen.findByText('No PR yet');

    const numbered: [string, string, string][] = [
      ['job-00000021', '36', 'merged'],
      ['job-00000022', '53', 'draft'],
    ];
    for (const [id, n, phase] of numbered) {
      const link = within(boardRowOf(id)).getByRole('link', { name: `PR #${n}` });
      expect(link).toHaveTextContent(new RegExp(`^#${n}$`));
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer noopener');
      const cell = must(link.closest('td'));
      expect(must(cell.querySelector('[data-phase]'))).toHaveAttribute('data-phase', phase);
      // The state comes from the phase chip alone: it is in the cell once, in the chip.
      expect(cell.textContent.split(phase)).toHaveLength(2);
      expect(cell.textContent).not.toContain('PR (');
    }
    expect(
      within(boardRowOf('job-00000022')).getByRole('link', { name: 'PR #53' }),
    ).toHaveAttribute('href', 'https://github.com/x/y/pull/53/');

    // A URL with no trailing /pull/<n> is named plainly.
    const odd = within(boardRowOf('job-00000023')).getByRole('link', { name: 'PR' });
    expect(odd).toHaveTextContent(/^PR$/);
    expect(odd).toHaveAttribute('href', 'https://example.test/pr');

    // No PR: a dash, read as "no PR", and no link in the cell.
    const none = within(boardRowOf('job-00000024')).getByRole('img', { name: 'no PR' });
    expect(none).toHaveTextContent(/^—$/);
    const cell = must(none.closest('td'));
    expect(cell.textContent).toBe('—');
    expect(within(cell).queryByRole('link')).toBeNull();
    expect(document.body.textContent).not.toContain('PR (');
  });

  it('names how a completed job ended and keeps its CI chip secondary, hidden once merged and passing', async () => {
    mockFetch();
    const done = (id: string, over: Partial<BoardRow>) =>
      row({
        id,
        title: `Done ${id}`,
        stage: 'completed',
        status: 'completed',
        liveness: 'completed',
        owner: null,
        pr: { url: pr, state: 'ready', phase: 'ready-to-merge', refreshable: false },
        ci: noCi({ status: 'passing', head, completion: 'ci' }),
        ...over,
      });
    data.rows = [
      done('job-00000011', {
        outcome: { kind: 'merged', label: 'completed: merged' },
        pr: { url: pr, state: 'merged', phase: 'merged', refreshable: false },
      }),
      done('job-00000012', {
        outcome: { kind: 'ready', label: 'completed: PR ready, checks passed' },
      }),
      done('job-00000013', {
        outcome: { kind: 'human', label: 'completed: human close-out' },
        pr: { url: pr, state: 'draft', phase: 'ci-failing', refreshable: false },
        ci: noCi({ status: 'failing', head, completion: 'human' }),
      }),
      done('job-00000014', {
        outcome: { kind: 'completed', label: 'completed' },
        pr: { url: pr, state: 'ready', phase: 'ci-failing', refreshable: false },
        ci: noCi({ status: 'failing', head, completion: 'ci' }),
      }),
      done('job-00000015', {
        outcome: { kind: 'merged', label: 'completed: merged' },
        pr: { url: pr, state: 'merged', phase: 'merged', refreshable: false },
        ci: noCi({ status: 'failing', head, completion: 'ci' }),
      }),
      // Merged by a human before CI finished: the merge is the headline, never "CI pending".
      done('job-00000017', {
        outcome: { kind: 'merged', label: 'completed: merged' },
        pr: { url: pr, state: 'merged', phase: 'merged', refreshable: false },
        ci: noCi({ status: 'pending', head, completion: 'merged' }),
      }),
      row({
        id: 'job-00000016',
        title: 'Still running',
        pr: { url: pr, state: 'draft', phase: 'ci-failing', refreshable: false },
        ci: noCi({ status: 'failing', head }),
      }),
    ];
    mount();
    await screen.findByText('Still running');
    const status = (id: string) => must(boardRowOf(id).querySelector<HTMLElement>('[data-state]'));
    const ciChip = (id: string) => boardRowOf(id).querySelector<HTMLElement>('[data-ci]');
    const expected: [string, string, string][] = [
      ['job-00000011', 'merged', '✓ completed: merged'],
      ['job-00000012', 'ready', '✓ completed: PR ready, checks passed'],
      ['job-00000013', 'human', '✓ completed: human close-out'],
      ['job-00000014', 'completed', '✓ completed'],
      ['job-00000017', 'merged', '✓ completed: merged'],
    ];
    for (const [id, kind, label] of expected) {
      const chip = status(id);
      expect(chip).toHaveAttribute('data-state', 'completed');
      expect(chip).toHaveAttribute('data-outcome', kind);
      expect(chip.textContent).toBe(label);
      expect(chip.className).toContain('MuiChip-colorSuccess');
    }
    // Merged with passing CI: the outcome says it all, so the board shows no CI chip.
    expect(ciChip('job-00000011')).toBeNull();
    // Merged before CI finished: no CI chip and no "CI pending" text in the row.
    expect(ciChip('job-00000017')).toBeNull();
    expect(boardRowOf('job-00000017').textContent).not.toContain('CI pending');
    // Any other completed row keeps its CI evidence, outlined as secondary.
    for (const id of ['job-00000012', 'job-00000013', 'job-00000014', 'job-00000015']) {
      expect(must(ciChip(id)).className).toContain('MuiChip-outlined');
    }
    // A job that is not completed is unchanged: no outcome, a filled CI chip.
    expect(status('job-00000016')).not.toHaveAttribute('data-outcome');
    expect(must(ciChip('job-00000016')).className).toContain('MuiChip-filled');
  });

  it('shows the outcome in the detail header and keeps the CI chip and line in the PR tab', async () => {
    mockFetch();
    const base = readyDetail();
    data.detail = readyDetail({
      job: { ...base.job, prState: 'merged' },
      outcome: { kind: 'merged', label: 'completed: merged' },
      ci: noCi({
        status: 'passing',
        head,
        completion: 'ci',
        line: 'Completed: required checks passed for abcdef0.',
      }),
      prPhase: 'merged',
      actions: ['archive'],
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    const chip = must(document.querySelector<HTMLElement>('[data-state="completed"]'));
    expect(chip).toHaveAttribute('data-outcome', 'merged');
    expect(chip.textContent).toBe('✓ completed: merged');
    fireEvent.click(screen.getByRole('tab', { name: 'PR' }));
    const panel = screen.getByTestId('ci-panel');
    expect(panel).toHaveTextContent('CI passing @abcdef0');
    expect(panel).toHaveTextContent('Completed: required checks passed for abcdef0.');
  });

  it('renders Merge and Refresh PR only when the server lists them', async () => {
    mockFetch();
    data.detail = readyDetail({ actions: ['archive'] });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(must(document.querySelector('[data-phase="ready-to-merge"]'))).toHaveTextContent(
      'ready to merge',
    );
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh PR' })).not.toBeInTheDocument();
    cleanup();

    data.detail = readyDetail({ actions: ['refresh-pr', 'archive'] });
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh PR' })).toBeInTheDocument();
  });

  it('Merge is a plain confirm naming the PR and the short SHA, posted with force', async () => {
    const f = mockFetch();
    data.detail = readyDetail();
    data.actionBody = { job: readyDetail().job, message: `Merged ${pr} at abcdef0.` };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('merge-confirm')).toHaveTextContent(pr);
    expect(within(dialog).getByTestId('merge-confirm')).toHaveTextContent('abcdef0');
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Merged');
    });
    expect(posts(f)).toEqual([{ action: 'merge', force: true }]);
  });

  it('Merge shows the readiness grade, fetched when the dialog opens, as advice', async () => {
    const f = mockFetch();
    data.detail = readyDetail();
    data.readiness = {
      grade: {
        letter: 'C',
        met: 2,
        facts: { policyTest: true, requiredChecks: true, upToDate: false, protection: null },
        advice: ['Require branches to be up to date.', 'Protect the base branch.'],
      },
    };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    const asked = () => f.mock.calls.filter(([u]) => String(u).endsWith('/readiness')).length;
    expect(asked()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog');
    const grade = await within(dialog).findByTestId('merge-readiness');
    expect(grade).toHaveTextContent('Repository readiness C (2/4), advice only.');
    expect(grade).toHaveTextContent('Protect the base branch.');
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeEnabled();
    expect(asked()).toBe(1);
  });

  it('Remove worktree is a plain confirm naming the path and the kept branch', async () => {
    const f = mockFetch();
    const merged = readyDetail().job;
    const job = { ...merged, prState: 'merged' as const, worktreePath: '/wt/job', branch: 'b1' };
    data.detail = readyDetail({ job, actions: ['remove-worktree', 'archive'] });
    data.actionBody = { job, message: 'Removed the worktree /wt/job. The branch b1 is kept.' };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove worktree' }));
    const dialog = await screen.findByRole('dialog');
    const text = within(dialog).getByTestId('remove-worktree-confirm');
    expect(text).toHaveTextContent('/wt/job');
    expect(text).toHaveTextContent('b1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove worktree' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Removed the worktree');
    });
    expect(posts(f)).toEqual([{ action: 'remove-worktree', force: true }]);
  });

  it('Fix merge conflicts shows only when listed and its confirm names the files', async () => {
    const f = mockFetch();
    data.detail = detail({ actions: ['request-rework', 'cancel'] });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('button', { name: 'Fix merge conflicts' })).not.toBeInTheDocument();
    cleanup();

    const job = { ...detail().job, stage: 'approve' as const, status: 'pending' as const };
    data.detail = detail({
      job,
      actions: ['fix-conflicts', 'request-rework', 'cancel'],
      conflicts: { files: ['src/app.ts', 'README.md'], github: false },
    });
    data.actionBody = {
      job: { ...job, stage: 'build' },
      message: 'Merging origin/main conflicts in src/app.ts, README.md: the job returned to build.',
      resumeCommand: 'orch factory resume job-00000003 --session <name>',
    };
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('button', { name: 'Fix merge conflicts' }));
    const dialog = await screen.findByRole('dialog');
    const files = within(dialog).getByTestId('fix-conflicts-files');
    expect(
      within(files)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['src/app.ts', 'README.md']);
    const effect = within(dialog).getByTestId('action-effect');
    expect(effect).toHaveTextContent('returns to build');
    expect(effect).toHaveTextContent('No session is started');
    // The files are listed once, not repeated in the effect sentence.
    expect(effect).not.toHaveTextContent('README.md');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('returned to build');
    });
    expect(posts(f)).toEqual([{ action: 'fix-conflicts' }]);
  });

  it('Edit spec shows only when listed, opens prefilled, and posts the edited text', async () => {
    const f = mockFetch();
    const spec = '# Spec\n\n## Goal\n\nold\n';
    data.detail = detail({ actions: ['request-rework', 'cancel'], contents: { 'spec.md': spec } });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByRole('button', { name: 'Edit spec' })).not.toBeInTheDocument();
    cleanup();

    const job = { ...detail().job, returnStage: 'spec' as const };
    data.detail = detail({
      job,
      actions: ['edit-spec', 'request-rework', 'cancel'],
      contents: { 'spec.md': spec },
    });
    data.actionBody = { job, message: 'spec.md replaced (abc1234). The job still waits.' };
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit spec' }));
    let dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox', { name: 'spec.md' });
    expect(box).toHaveValue(spec);
    fireEvent.change(box, { target: { value: spec + 'new\n' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('spec.md replaced');
    });
    expect(posts(f)).toEqual([{ action: 'edit-spec', content: spec + 'new\n' }]);
    const post = (f.mock.calls as [RequestInfo | URL, RequestInit | undefined][]).find(
      ([, i]) => i?.method === 'POST',
    );
    expect(new Headers(post?.[1]?.headers).get('X-Orch-Csrf')).toBe('tok');

    data.actionStatus = 400;
    data.actionBody = {
      error: { type: 'ValidationError', message: 'spec.md is missing required section(s)' },
    };
    fireEvent.click(screen.getByRole('button', { name: 'Edit spec' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('ValidationError: spec.md is missing required section(s)'),
    ).toBeInTheDocument();
  });

  it('Fix merge conflicts words its dialog for ci, a completed re-land, and GitHub-only', async () => {
    mockFetch();
    const base = detail().job;
    const cases = [
      {
        job: { ...base, stage: 'ci' as const, status: 'running' as const },
        conflicts: { files: ['src/app.ts'], github: false },
        says: ['The branch conflicts with its base', 'returns to build', 'no CI repair is used'],
        not: ['re-land'],
      },
      {
        job: { ...base, stage: 'completed' as const, status: 'completed' as const },
        conflicts: { files: [], github: true },
        says: [
          'GitHub reports the PR CONFLICTING',
          'creates a re-land job and marks this one superseded',
          'start it yourself',
        ],
        not: ['returns to build'],
      },
      {
        job: { ...base, stage: 'pr' as const, status: 'pending' as const },
        conflicts: { files: [], github: true },
        says: ['GitHub reports the PR CONFLICTING', 'returns to build'],
        not: ['no CI repair'],
      },
    ];
    for (const c of cases) {
      cleanup();
      data.detail = detail({
        job: c.job,
        actions: ['fix-conflicts'],
        conflicts: c.conflicts,
      });
      window.location.hash = '#/jobs/job-00000003';
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Fix merge conflicts' }));
      const dialog = await screen.findByRole('dialog');
      const effect = within(dialog).getByTestId('action-effect');
      for (const s of c.says) expect(effect).toHaveTextContent(s);
      for (const s of c.not) expect(effect).not.toHaveTextContent(s);
      // No file list is shown when only GitHub reports the conflict.
      expect(within(dialog).queryByTestId('fix-conflicts-files') === null).toBe(
        c.conflicts.files.length === 0,
      );
    }
  });

  it('Refresh PR posts at once and shows a refused merge error', async () => {
    const f = mockFetch();
    data.detail = readyDetail();
    data.actionBody = { job: readyDetail().job, message: `GitHub reports ${pr} as merged.` };
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh PR' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('as merged');
    });
    expect(posts(f)).toEqual([{ action: 'refresh-pr', force: true }]);

    data.actionStatus = 400;
    data.actionBody = {
      error: { type: 'ValidationError', message: 'gh pr merge failed: not mergeable' },
    };
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await within(dialog).findByText(/not mergeable/)).toBeInTheDocument();
    // The earlier refresh's success does not sit beside the new error.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('Board attention order, summary chips, review rollup', () => {
  const ids = () =>
    [...document.querySelectorAll<HTMLElement>('[data-job-id]')].map((r) => r.dataset['jobId']);

  it('labels repositories by basename, a longer unique suffix on collision, nothing for one repo', () => {
    const labels = (...repos: string[]) => Object.fromEntries(repoLabels(repos));
    expect(labels('github.com/acme/alpha', 'github.com/acme/alpha')).toEqual({});
    expect(labels()).toEqual({});
    expect(labels('github.com/acme/alpha', 'github.com/acme/beta', 'gamma')).toEqual({
      'github.com/acme/alpha': 'alpha',
      'github.com/acme/beta': 'beta',
      gamma: 'gamma',
    });
    expect(
      labels('github.com/acme/alpha', 'github.com/other/alpha', 'github.com/acme/beta'),
    ).toEqual({
      'github.com/acme/alpha': 'acme/alpha',
      'github.com/other/alpha': 'other/alpha',
      'github.com/acme/beta': 'beta',
    });
    // No unique suffix: the full identity.
    expect(labels('acme/alpha', 'x/acme/alpha')).toEqual({
      'acme/alpha': 'acme/alpha',
      'x/acme/alpha': 'x/acme/alpha',
    });
  });

  it('orders by attention group, then most recently updated first', () => {
    const at = (
      id: string,
      liveness: BoardRow['liveness'],
      updatedAt = '2026-11-13T08:00:00.000Z',
    ) => row({ id, liveness, updatedAt });
    const input = [
      at('cancelled', 'cancelled'),
      at('completed', 'completed', '2026-11-13T09:00:00.000Z'),
      at('idle', 'idle'),
      at('running', 'running'),
      at('interrupted', 'interrupted', '2026-11-13T07:00:00.000Z'),
      at('failed', 'failed'),
      at('stale', 'stale'),
      at('blocked-old', 'blocked'),
      at('blocked-new', 'blocked', '2026-11-13T09:00:00.000Z'),
    ];
    expect([...input].sort(byAttention).map((r) => r.id)).toEqual([
      'blocked-new',
      'blocked-old',
      'stale',
      'failed',
      'interrupted',
      'running',
      'idle',
      'completed',
      'cancelled',
    ]);
  });

  it('rolls a round up into one verdict', () => {
    const v = (reviewer: string, verdict: 'pass' | 'changes' | null) => ({ reviewer, verdict });
    expect(reviewRollup([])).toBeNull();
    expect(reviewRollup([v('a', 'pass'), v('b', 'pass')])).toEqual({
      label: '2/2 pass',
      color: 'success',
    });
    expect(reviewRollup([v('a', 'pass'), v('b', null), v('c', null)])).toEqual({
      label: '1/3, 2 pending',
      color: 'default',
    });
    expect(reviewRollup([v('a', 'pass'), v('b', 'changes'), v('c', null)])).toEqual({
      label: '1 changes',
      color: 'warning',
    });
  });

  it('colours pending CI as information and missing CI as a warning', () => {
    expect(ciColor('pending')).toBe('info');
    expect(ciColor('none')).toBe('warning');
    expect(ciColor('passing')).toBe('success');
    expect(ciColor('failing')).toBe('error');
    expect(ciColor(null)).toBe('default');
    const colours = ['pending', 'none', 'passing', 'failing', null].map(ciColor);
    expect(new Set(colours).size).toBe(5);
  });

  it('shows the rollup with every reviewer in its tooltip and folds in the blocking count', async () => {
    // A stored choice naming the removed Blocking column is harmless.
    window.localStorage.setItem('orch.board.hiddenColumns', JSON.stringify(['blocking', 'repo']));
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).not.toContain('Blocking');
    const stale = must(table.querySelector<HTMLElement>('[data-job-id="job-00000002"]'));
    const rollup = within(stale).getByText('1/2, 1 pending');
    expect(
      must(within(stale).getByText('2 blocking').closest('.MuiChip-root')).className,
    ).toContain('MuiChip-colorError');
    // No reviews and no blocking count: the cell is empty.
    const running = must(table.querySelector<HTMLElement>('[data-job-id="job-00000001"]'));
    expect(within(running).queryByText(/pass|pending|changes|blocking/)).not.toBeInTheDocument();
    fireEvent.mouseOver(rollup);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('security: pass');
    expect(tip).toHaveTextContent('correctness: pending');
    expect(within(table).queryByText('correctness: pending')).not.toBeInTheDocument();
  });

  it('summary chips filter the board, and Show lists a count per option', async () => {
    data.rows = [
      ...rows,
      row({ id: 'job-0000000b', title: 'Failed', status: 'failed', liveness: 'failed' }),
      row({ id: 'job-0000000c', title: 'Stopped', status: 'interrupted', liveness: 'interrupted' }),
      row({ id: 'job-0000000d', title: 'Waiting', status: 'pending', liveness: 'idle' }),
      row({
        id: 'job-00000009',
        title: 'Omega archived',
        status: 'completed',
        liveness: 'completed',
        archivedAt: '2026-11-14T00:00:00.000Z',
      }),
    ];
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    const summary = screen.getByLabelText('Summary');
    const chip = (name: string) => within(summary).getByRole('button', { name });
    expect(
      within(summary)
        .getAllByRole('button')
        .map((c) => c.textContent),
    ).toEqual(['1 running', '1 stale', '1 need human', '2 failed', '1 idle']);
    // Pressed shows as a visible ring as well as aria-pressed; unpressed chips have none.
    const ringed = () =>
      within(summary)
        .getAllByRole('button')
        .filter((c) => getComputedStyle(c).outlineStyle === 'solid')
        .map((c) => c.textContent);
    for (const c of within(summary).getAllByRole('button')) {
      expect(c).toHaveAttribute('aria-pressed', 'false');
    }
    expect(ringed()).toEqual([]);
    const show = screen.getByRole('combobox', { name: 'Show' });
    expect(show).toHaveDisplayValue('current (7)');

    fireEvent.click(chip('1 need human'));
    await waitFor(() => {
      expect(ids()).toEqual(['job-00000003']);
    });
    expect(chip('1 need human')).toHaveAttribute('aria-pressed', 'true');
    expect(ringed()).toEqual(['1 need human']);
    // An explicit text-colour ring, not currentColor (white on a filled chip).
    expect(getComputedStyle(chip('1 need human')).outlineColor).toBe(theme.palette.text.primary);
    expect(getComputedStyle(chip('1 need human')).outlineWidth).toBe('2px');
    expect(show).toHaveDisplayValue('needs human (1)');
    fireEvent.click(chip('2 failed'));
    await waitFor(() => {
      expect(ids()).toEqual(['job-0000000b', 'job-0000000c']);
    });
    expect(chip('1 need human')).toHaveAttribute('aria-pressed', 'false');
    // Clicking the pressed chip again returns to current.
    fireEvent.click(chip('2 failed'));
    await waitFor(() => {
      expect(ids()).toHaveLength(7);
    });
    expect(show).toHaveDisplayValue('current (7)');
    for (const [name, id] of [
      ['1 running', 'job-00000001'],
      ['1 stale', 'job-00000002'],
      ['1 idle', 'job-0000000d'],
    ] as const) {
      fireEvent.click(chip(name));
      await waitFor(() => {
        expect(ids()).toEqual([id]);
      });
    }

    expect(
      within(show)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'current (7)',
      'active (5)',
      'needs human (1)',
      'running (1)',
      'stale (1)',
      'failed (2)',
      'idle (1)',
      'finished (1)',
      'cancelled (1)',
      'archived (1)',
    ]);
  });
});

describe('Job detail: tab counts, empty, and unavailable tabs (todo 0015)', () => {
  const art = (id: number, path: string) =>
    ({
      id,
      jobId: 'job-00000003',
      stage: 'spec',
      round: null,
      path,
      bytes: 10,
      sha256: null,
      marker: null,
      head: null,
      specSha256: null,
      createdAt: '2026-11-13T08:20:00.000Z',
    }) satisfies JobDetailView['artifacts'][number];
  const events = (n: number): JobDetailView['events'] =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      jobId: 'job-00000003',
      type: 'job.note',
      payload: {},
      actor: null,
      createdAt: '2026-11-13T08:00:00.000Z',
    }));
  const round = (n: number, blocking: number | null, consolidated = true) => ({
    round: n,
    reviews: [],
    consolidated: consolidated ? `round-${String(n)}/consolidated.md` : null,
    blocking,
  });
  const reasons = {
    Spec: 'Spec needs spec.md (spec stage).',
    Build: 'Build needs build.md (build stage).',
    Decision: 'Decision needs decision.md (approve stage).',
    PR: 'PR needs an opened PR or pr.md (pr stage).',
  } as const;
  /** Just created: nothing registered, no rounds, events, plan, worktree, or PR. */
  function fresh(over: Partial<JobDetailView> = {}): JobDetailView {
    const base = detail();
    return detail({
      job: { ...base.job, stage: 'spec', status: 'pending', round: 0 },
      liveness: 'idle',
      blocker: null,
      artifacts: [],
      contents: {},
      rounds: [],
      events: [],
      plan: null,
      planError: 'no worktree',
      merge: null,
      ...over,
    });
  }
  /** Delivered: every document registered, two consolidated rounds (newest BLOCKING: 3), a PR. */
  function done(over: Partial<JobDetailView> = {}): JobDetailView {
    const base = detail();
    const paths = ['spec.md', 'build.md', 'round-1/consolidated.md', 'round-2/consolidated.md'];
    return detail({
      job: {
        ...base.job,
        stage: 'completed',
        status: 'completed',
        round: 2,
        prUrl: 'https://github.com/x/y/pull/9',
        prState: 'merged',
      },
      links: { ...base.links, pr: 'https://github.com/x/y/pull/9' },
      liveness: 'completed',
      blocker: null,
      artifacts: [...paths, 'decision.md', 'pr.md'].map((p, i) => art(i + 1, p)),
      contents: { 'spec.md': '# Spec\n\nThe spec body.\n' },
      rounds: [round(1, 5), round(2, 3)],
      events: events(34),
      claudeSessions: [{ ref: SESSION_UUID, attachedAt: '2026-11-13T08:10:00.000Z' }],
      plan: {
        step: 'done',
        reason: '',
        agents: [],
        artifacts: [],
        worktree: {
          path: '/wt/g',
          exists: true,
          isWorktree: true,
          branch: 'factory/job-00000003-gamma',
          head: '9999999988888888',
          dirty: [],
          baseRef: 'origin/main',
          ahead: 0,
          behind: 0,
          commits: [],
          changedFiles: [],
          changes: [],
          fingerprint: 'fp',
        },
        verification: {
          configured: true,
          policy: {
            source: 'baseline',
            head: 'abc1234567',
            fingerprint: 'fp',
            checks: ['check'],
            authorization: 'not-needed',
            candidateError: null,
          },
          run: null,
          valid: false,
          reason: 'no verification run recorded',
          queue: null,
        },
        sensitive: null,
        integration: null,
      } as unknown as JobDetailView['plan'],
      planError: null,
      ...over,
    });
  }
  const tab = (name: string) => screen.getByRole('tab', { name });
  const selectedTab = () =>
    screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');
  const show = async (d: JobDetailView) => {
    data.detail = d;
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
  };

  it('describes a fresh job: four tabs unavailable with reasons, the rest counted or empty (AC1)', () => {
    expect(detailTabs(fresh())).toEqual([
      { name: 'Overview', label: 'Overview', count: null, empty: false, unavailable: null },
      { name: 'Spec', label: 'Spec', count: null, empty: true, unavailable: reasons.Spec },
      { name: 'Build', label: 'Build', count: null, empty: true, unavailable: reasons.Build },
      { name: 'Reviews', label: 'Reviews (0 rounds)', count: 0, empty: true, unavailable: null },
      { name: 'Findings', label: 'Findings (empty)', count: null, empty: true, unavailable: null },
      {
        name: 'Decision',
        label: 'Decision',
        count: null,
        empty: true,
        unavailable: reasons.Decision,
      },
      { name: 'Artifacts', label: 'Artifacts (0)', count: 0, empty: true, unavailable: null },
      { name: 'Events', label: 'Events (0)', count: 0, empty: true, unavailable: null },
      { name: 'Session', label: 'Session (empty)', count: null, empty: true, unavailable: null },
      { name: 'Git', label: 'Git (empty)', count: null, empty: true, unavailable: null },
      {
        name: 'Verification',
        label: 'Verification (empty)',
        count: null,
        empty: true,
        unavailable: null,
      },
      { name: 'PR', label: 'PR', count: null, empty: true, unavailable: reasons.PR },
    ]);
  });

  it('describes a completed job: nothing unavailable, newest round blocking count (AC1)', () => {
    const tabs = detailTabs(done());
    expect(tabs.map((t) => t.name)).toEqual([...TABS]);
    expect(tabs.map((t) => t.label)).toEqual([
      'Overview',
      'Spec',
      'Build',
      'Reviews (2 rounds)',
      'Findings (3 blocking)',
      'Decision',
      'Artifacts (6)',
      'Events (34)',
      'Session',
      'Git',
      'Verification',
      'PR',
    ]);
    expect(tabs.every((t) => t.unavailable === null && !t.empty)).toBe(true);
    expect(tabs.find((t) => t.name === 'Findings')?.count).toBe(3);
    expect(tabs.find((t) => t.name === 'Reviews')?.count).toBe(2);
    // A recorded merge alone gives Git content; pr.md alone makes PR available.
    const merged = detailTabs(
      fresh({
        merge: {
          base: 'main',
          prUrl: null,
          head: null,
          mergeCommit: null,
          verified: null,
          historyKnown: false,
          commits: [],
          changedFiles: [],
          outstanding: null,
        },
        artifacts: [art(1, 'pr.md')],
      }),
    );
    expect(merged.find((t) => t.name === 'Git')?.label).toBe('Git');
    expect(merged.find((t) => t.name === 'PR')?.unavailable).toBeNull();
  });

  it('counts the newest consolidated round, including 0, and labels truncated events (AC1, AC3)', () => {
    const findings = (rounds: JobDetailView['rounds']) =>
      detailTabs(fresh({ rounds })).find((t) => t.name === 'Findings');
    // Round 3 has no consolidation yet: round 2 is the newest consolidated round.
    expect(findings([round(1, 5), round(2, 0), round(3, null, false)])).toEqual({
      name: 'Findings',
      label: 'Findings (0 blocking)',
      count: 0,
      empty: false,
      unavailable: null,
    });
    expect(findings([round(1, 5), round(2, null)])).toEqual({
      name: 'Findings',
      label: 'Findings',
      count: null,
      empty: false,
      unavailable: null,
    });
    // Reviews counts round sections, with or without reviewers or consolidation.
    const reviews = detailTabs(fresh({ rounds: [round(1, null, false)] })).find(
      (t) => t.name === 'Reviews',
    );
    expect(reviews?.label).toBe('Reviews (1 round)');
    const capped = detailTabs(fresh({ events: events(500), eventsCapped: true })).find(
      (t) => t.name === 'Events',
    );
    expect(capped).toMatchObject({ label: 'Events (500+)', count: 500 });
  });

  it('resolves an unavailable tab to Overview and an available one to itself (AC2)', () => {
    const d = fresh();
    for (const t of TABS) {
      expect(resolveTab(d, t)).toBe(t in reasons ? 'Overview' : t);
    }
    for (const t of TABS) expect(resolveTab(done(), t)).toBe(t);
  });

  it('puts counts in the accessible names of the rendered tabs (AC3, AC9)', async () => {
    await show(done());
    for (const name of [
      'Reviews (2 rounds)',
      'Findings (3 blocking)',
      'Artifacts (6)',
      'Events (34)',
    ]) {
      expect(tab(name)).toHaveTextContent(name);
      expect(tab(name)).not.toHaveAttribute('aria-label');
    }
    expect(screen.queryByTestId('tab-unavailable')).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab').filter((t) => t.hasAttribute('aria-disabled'))).toEqual([]);
    // Ids and panels are keyed by tab name, not label.
    fireEvent.click(tab('Reviews (2 rounds)'));
    expect(tab('Reviews (2 rounds)')).toHaveAttribute('id', 'tab-Reviews');
    expect(tab('Reviews (2 rounds)')).toHaveAttribute('aria-controls', 'panel-Reviews');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', 'panel-Reviews');
    expect(panel).toHaveAttribute('aria-labelledby', 'tab-Reviews');
    expect(panel).toHaveAccessibleName('Reviews (2 rounds)');
    cleanup();
    await show(done({ events: events(500), eventsCapped: true }));
    expect(tab('Events (500+)')).toBeInTheDocument();
  });

  it('keeps empty tabs reachable with a text cue and their empty text (AC4)', async () => {
    await show(fresh());
    const cases: [string, RegExp][] = [
      ['Reviews (0 rounds)', /No review rounds yet\./],
      ['Findings (empty)', /No consolidated findings yet\./],
      ['Artifacts (0)', /No artifacts registered\./],
      ['Events (0)', /No events recorded\./],
      ['Session (empty)', /No Claude Code session is recorded for this job\./],
      ['Git (empty)', /No worktree on disk/],
      ['Verification (empty)', /Plan unavailable\./],
    ];
    for (const [name, text] of cases) {
      expect(tab(name)).not.toHaveAttribute('aria-disabled');
      fireEvent.click(tab(name));
      expect(tab(name)).toHaveAttribute('aria-selected', 'true');
      // The Session panel fetches its own data.
      await waitFor(() => {
        expect(screen.getByRole('tabpanel')).toHaveTextContent(text);
      });
    }
  });

  it('disables the four unavailable tabs with a visible, described explanation (AC5, AC7)', async () => {
    await show(fresh());
    const block = screen.getByTestId('tab-unavailable');
    expect(block).toBeVisible();
    expect(block).toHaveTextContent(
      `Not available yet: ${reasons.Spec} ${reasons.Build} ${reasons.Decision} ${reasons.PR}`,
    );
    for (const [name, reason] of Object.entries(reasons)) {
      const t = tab(name);
      expect(t).toHaveAttribute('aria-disabled', 'true');
      expect(t).toHaveAccessibleDescription(reason);
      expect(t).toHaveAttribute('aria-describedby', `tab-reason-${name}`);
      expect(document.querySelectorAll(`[id="tab-reason-${name}"]`)).toHaveLength(1);
    }
    // No tab is disabled without an explanation, on either fixture.
    const undescribed = () =>
      screen
        .getAllByRole('tab')
        .filter((t) => t.getAttribute('aria-disabled') === 'true')
        .filter((t) => {
          const by = t.getAttribute('aria-describedby');
          return !by || !document.getElementById(by)?.textContent.trim();
        });
    expect(undescribed()).toEqual([]);
    cleanup();
    await show(done());
    expect(undescribed()).toEqual([]);
  });

  it('ignores a disabled tab activated by click or keyboard, and arrows skip it (AC6)', async () => {
    await show(fresh());
    fireEvent.click(tab('Events (0)'));
    const before = screen.getByRole('tabpanel').innerHTML;
    const spec = tab('Spec');
    fireEvent.click(spec);
    expect(spec).toHaveAttribute('aria-selected', 'false');
    expect(selectedTab()).toBe(tab('Events (0)'));
    spec.focus();
    for (const key of ['Enter', ' ']) {
      fireEvent.keyDown(spec, { key });
      fireEvent.keyUp(spec, { key });
    }
    expect(selectedTab()).toBe(tab('Events (0)'));
    expect(screen.getByRole('tabpanel').innerHTML).toBe(before);
    // Roving focus: from Overview, ArrowRight skips Spec and Build.
    tab('Overview').focus();
    fireEvent.keyDown(tab('Overview'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Reviews (0 rounds)'));
  });

  it('falls back to Overview at render time when the tab goes away, and returns to it (AC8)', async () => {
    const withSpec = fresh({ artifacts: [art(1, 'spec.md')], contents: { 'spec.md': 'Body A' } });
    await show(withSpec);
    fireEvent.click(tab('Spec'));
    expect(await screen.findByText('Body A')).toBeInTheDocument();
    // Watch for the Spec panel being drawn without spec.md, even for one commit.
    let drawnUnavailable = false;
    const observer = new MutationObserver(() => {
      if (document.body.textContent.includes('Not available (spec.md).')) drawnUnavailable = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    data.detail = fresh();
    await waitFor(() => {
      expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-Overview');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Request');
    expect(tab('Spec')).toHaveAttribute('aria-disabled', 'true');
    // A later poll refetches the same unavailable state: still Overview.
    const detailCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([u]) => u === '/api/jobs/job-00000003').length;
    const polled = detailCalls();
    await waitFor(() => {
      expect(detailCalls()).toBeGreaterThan(polled + 1);
    });
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    observer.disconnect();
    expect(drawnUnavailable).toBe(false);
    // The pick was kept: once spec.md is back, Spec is shown again.
    data.detail = withSpec;
    await waitFor(() => {
      expect(tab('Spec')).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByText('Body A')).toBeInTheDocument();
    // An available tab stays selected across polls.
    fireEvent.click(tab('Events (0)'));
    await new Promise((r) => setTimeout(r, 200));
    expect(tab('Events (0)')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Job detail: Events tab (ticket 0018)', () => {
  const HEAD = '92e988a0c1d2e3f4';
  const ACTOR = 'claude-20261113-0800-1d2e-a-very-long-session-name';
  const at = (m: number) => `2026-11-13T08:${String(m).padStart(2, '0')}:00.000Z`;
  /** Oldest first, as the server sends them. */
  const events: JobDetailView['events'] = (
    [
      ['stage.started', { stage: 'build' }],
      ['stage.completed', { stage: 'build', round: 1 }],
      ['branch.pushed', { branch: 'factory/job-00000003-gamma', head: HEAD }],
      ['ci.observed', { ciStatus: 'pending', head: HEAD, outcome: 'pending', polls: 4 }],
      ['ci.observed', { ciStatus: 'passing', head: HEAD, outcome: 'passing', polls: 5 }],
      ['stage.completed', { stage: 'ci', round: 1 }],
      ['job.note', {}],
    ] as const
  ).map(([type, payload], i) => ({
    id: i + 1,
    jobId: 'job-00000003',
    type,
    payload,
    actor: i === 4 ? ACTOR : null,
    createdAt: at(i + 1),
  }));
  const open = async () => {
    data.detail = detail({ events });
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('tab', { name: 'Events (7)' }));
    return screen.getByRole('table', { name: 'Events' });
  };
  const bodyRows = (table: HTMLElement) =>
    within(table).getAllByRole<HTMLTableRowElement>('row').slice(1);

  it('shows every event newest first, each with a summary line and a collapsed payload (AC3, AC8)', async () => {
    const table = await open();
    const rows = bodyRows(table);
    // No event dropped or merged: one row per event, newest first.
    expect(rows).toHaveLength(events.length);
    expect(rows.map((r) => r.querySelector('time')?.getAttribute('datetime'))).toEqual(
      events.map((e) => e.createdAt).reverse(),
    );
    expect(rows.map((r) => r.cells[1]?.textContent)).toEqual(events.map((e) => e.type).reverse());
    const summaries = rows.map((r) => r.querySelector('summary')?.textContent);
    expect(summaries).toEqual([
      'payload',
      'ci, round 1',
      'passing @92e988a, poll 5',
      'pending @92e988a, poll 4',
      'factory/job-00000003-gamma @92e988a',
      'build, round 1',
      'build',
    ]);
    // Collapsed by default; opened, the payload is pretty-printed, one key per indented line.
    const row = must(rows[2]);
    const details = must(row.querySelector('details'));
    const pre = must(details.querySelector('pre'));
    for (const d of table.querySelectorAll('details')) expect(d.open).toBe(false);
    expect(pre).not.toBeVisible();
    // jsdom does not toggle a <details> on a click of its <summary>; a browser does (e2e).
    details.open = true;
    expect(pre).toBeVisible();
    expect(pre.textContent).toContain('\n  "outcome": "passing",\n  "polls": 5\n');
    expect(pre.textContent).toBe(JSON.stringify(events[4]?.payload, null, 2));
  });

  it('keeps every cell inside a fixed layout, the actor on one line with its full value (AC4)', async () => {
    const table = await open();
    expect(getComputedStyle(table).tableLayout).toBe('fixed');
    const widths = within(table)
      .getAllByRole('columnheader')
      .map((h) => getComputedStyle(h).width);
    expect(widths.slice(0, 3)).toEqual(['14%', '22%', '18%']);
    const row = must(bodyRows(table)[2]);
    const actor = must(row.cells[2]);
    expect(actor).toHaveTextContent(ACTOR);
    expect(actor).toHaveAttribute('title', ACTOR);
    const style = getComputedStyle(actor);
    expect([style.whiteSpace, style.overflow, style.textOverflow]).toEqual([
      'nowrap',
      'hidden',
      'ellipsis',
    ]);
    expect(getComputedStyle(must(row.querySelector('pre'))).overflowX).toBe('auto');
    expect(getComputedStyle(must(row.cells[3])).overflowWrap).toBe('anywhere');
  });

  it('reads times relatively, with the local time and zone in the tooltip (AC6)', async () => {
    const table = await open();
    const time = must(bodyRows(table)[0]?.querySelector('time'));
    expect(time).toHaveTextContent(/ ago$/);
    expect(time).toHaveAttribute('datetime', at(7));
    expect(time).toHaveAttribute('title', localTime(at(7)));
    expect(time.getAttribute('title')).not.toBe(at(7));
  });

  it('filters by type, with a count per type and All types by default (AC7)', async () => {
    const table = await open();
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Type' });
    expect(select).toHaveDisplayValue('All types');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'All types',
      'branch.pushed (1)',
      'ci.observed (2)',
      'job.note (1)',
      'stage.completed (2)',
      'stage.started (1)',
    ]);
    await choose('Type', 'stage.completed (2)');
    expect(bodyRows(table).map((r) => r.querySelector('summary')?.textContent)).toEqual([
      'ci, round 1',
      'build, round 1',
    ]);
    await choose('Type', 'All types');
    expect(bodyRows(table)).toHaveLength(events.length);
  });
});

describe('Job detail: Session tab (todo 0074)', () => {
  const OLDER = '33333333-4444-4555-8666-777777777777';
  const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const builder = { id: 'a1', type: 'builder', description: 'Build round 1' };
  const withSession = (): JobDetailView =>
    detail({
      claudeSessions: [
        { ref: SESSION_UUID, attachedAt: t(30) },
        { ref: OLDER, attachedAt: t(90) },
      ],
    });
  const found = (): SessionLogView => ({
    ...noSessionLog(),
    found: true,
    reason: null,
    ref: SESSION_UUID,
    matches: 1,
    files: [
      { source: 'main', size: 2048, bytesRead: 2048, truncated: true, modifiedAt: t(1) },
      { source: 'agent-a1', size: 10, bytesRead: 10, truncated: false, modifiedAt: t(2) },
    ],
    subagents: [
      { ...builder, finished: false, modifiedAt: t(2) },
      {
        id: 'a2',
        type: 'reviewer',
        description: 'Security review',
        finished: true,
        modifiedAt: t(20),
      },
      // No meta (finished null), and finished: false but quiet for 30 minutes: both unknown.
      { id: 'a3', type: null, description: null, finished: null, modifiedAt: t(1) },
      { id: 'a4', type: 'tester', description: 'Old run', finished: false, modifiedAt: t(30) },
    ],
    subagentsNotRead: 3,
    entries: [
      { at: t(1), kind: 'assistant', text: 'Tests pass now.', truncated: false, agent: null },
      { at: t(2), kind: 'tool', text: 'Edit src/x.ts', truncated: false, agent: builder },
      {
        at: t(3),
        kind: 'result',
        text: '12 passed\nsecond line of output',
        truncated: false,
        agent: null,
      },
      {
        at: t(4),
        kind: 'user',
        text: '<b>bold</b> **not markdown** <img src=x onerror=alert(1)>',
        truncated: false,
        agent: null,
      },
    ],
    truncated: true,
  });
  const open = async (d: JobDetailView, name: string, refreshMs = 50) => {
    data.detail = d;
    const f = mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount(refreshMs);
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(screen.getByRole('tab', { name }));
    return f;
  };
  const logCalls = (f: FetchMock) =>
    f.mock.calls.filter(([u]) => String(u).endsWith('/session-log')).length;

  it('is Session (empty) without a claude-code session and Session with one, never disabled (AC8)', async () => {
    expect(detailTabs(detail()).find((x) => x.name === 'Session')).toEqual({
      name: 'Session',
      label: 'Session (empty)',
      count: null,
      empty: true,
      unavailable: null,
    });
    expect(detailTabs(withSession()).find((x) => x.name === 'Session')).toEqual({
      name: 'Session',
      label: 'Session',
      count: null,
      empty: false,
      unavailable: null,
    });
    expect(resolveTab(detail(), 'Session')).toBe('Session');
    expect(resolveTab(withSession(), 'Session')).toBe('Session');
    await open(detail(), 'Session (empty)');
    const tabEl = screen.getByRole('tab', { name: 'Session (empty)' });
    expect(tabEl).not.toHaveAttribute('aria-disabled');
    expect(tabEl).toHaveStyle({ fontStyle: 'italic' });
    expect(tabEl).toHaveAttribute('aria-selected', 'true');
  });

  it('names the reason and the attach command when nothing is tied, as nothing to run (AC9)', async () => {
    await open(detail(), 'Session (empty)');
    const empty = await screen.findByTestId('session-log-empty');
    expect(empty).toHaveTextContent(NO_SESSION);
    expect(empty).toHaveTextContent(`Nothing to do here: the session runs ${ATTACH} itself.`);
    expect(empty).not.toHaveTextContent('--token');
    expect(empty).not.toHaveTextContent('claude --resume');
  });

  it('says a recorded session has no transcript here, with no instruction to attach (finding 2)', async () => {
    data.sessionLog = {
      ...noSessionLog(),
      ref: SESSION_UUID,
      reason:
        `Claude Code session ${SESSION_UUID} is recorded for this job, but its transcript ` +
        `${SESSION_UUID}.jsonl was not found in any project directory under /h/projects. ` +
        'It may be under another Claude home (CLAUDE_CONFIG_DIR) or on another machine.',
    };
    await open(withSession(), 'Session');
    const empty = await screen.findByTestId('session-log-empty');
    expect(empty).toHaveTextContent(`${SESSION_UUID}.jsonl was not found`);
    expect(empty).toHaveTextContent('/h/projects');
    expect(empty).toHaveTextContent(`claude --resume ${SESSION_UUID}`);
    expect(empty).not.toHaveTextContent('orch job session attach');
    expect(empty).not.toHaveTextContent('--token');
  });

  it('says when a transcript was read but nothing in it could be shown, outside any list (findings 2, 3)', async () => {
    data.sessionLog = { ...found(), entries: [], truncated: false };
    await open(withSession(), 'Session');
    const none = await screen.findByTestId('session-log-no-entries');
    expect(none).toHaveTextContent(
      'The transcript has content, but none of its records could be shown: it may be unreadable or ' +
        'in a format this dashboard does not recognise.',
    );
    expect(screen.queryByRole('list', { name: 'Session timeline' })).toBeNull();
    expect(none.closest('ol, ul')).toBeNull();
    // Every list child on the panel is an <li>.
    for (const list of screen.getByRole('tabpanel').querySelectorAll('ol, ul')) {
      for (const child of list.children) expect(child.tagName).toBe('LI');
    }
    cleanup();
    data.sessionLog = {
      ...found(),
      entries: [],
      truncated: false,
      files: [{ source: 'main', size: 0, bytesRead: 0, truncated: false, modifiedAt: t(1) }],
    };
    await open(withSession(), 'Session');
    expect(await screen.findByTestId('session-log-no-entries')).toHaveTextContent(
      'No activity is recorded in the transcript yet.',
    );
  });

  it('reads status unknown only for a null finished, whatever the modified time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const s = (finished: boolean | null, ageMs: number) =>
      subagentState(
        {
          id: 'x',
          type: null,
          description: null,
          finished,
          modifiedAt: new Date(now - ageMs).toISOString(),
        },
        now,
      );
    for (const age of [0, 60_000, RUNNING_WINDOW_MS, 3_600_000]) {
      expect(s(null, age)).toBe('status unknown');
      expect(s(true, age)).toBe('finished');
      expect(s(false, age)).toBe(age < RUNNING_WINDOW_MS ? 'running' : 'not finished');
    }
  });

  it('renders the timeline newest first with times, agent labels, subagents, and earlier sessions (AC2, AC9)', async () => {
    data.sessionLog = found();
    await open(withSession(), 'Session');
    const list = await screen.findByRole('list', { name: 'Session timeline' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-kind'))).toEqual([
      'assistant',
      'tool',
      'result',
      'user',
    ]);
    expect(items[0]).toHaveTextContent('1m ago');
    expect(items[0]).toHaveTextContent('main');
    expect(items[1]).toHaveTextContent('builder: Build round 1');
    const time = must(items[1]?.querySelector('time'));
    const at = must(data.sessionLog.entries[1]?.at);
    expect(time).toHaveAttribute('datetime', at);
    expect(time).toHaveAttribute('title', localTime(at));
    expect(localTime(at)).not.toBe(at);
    expect(time).toHaveTextContent('2m ago');
    const subs = screen.getByTestId('session-subagents');
    const sub = (id: string) => must(subs.querySelector(`[data-agent-id="${id}"]`));
    expect(sub('a1')).toHaveTextContent(/^builder: Build round 1 — running, last active 2m ago$/);
    expect(sub('a2')).toHaveTextContent(/^reviewer: Security review — finished, last active/);
    // finished missing: status unknown, explained; false but quiet past the window: not finished.
    expect(sub('a3')).toHaveTextContent(
      /^agent: a3 — status unknown \(its meta file has no readable finished field\), last active 1m ago$/,
    );
    expect(sub('a4')).toHaveTextContent(/^tester: Old run — not finished, last active 30m ago$/);
    expect(sub('a4')).not.toHaveTextContent('status unknown');
    expect(within(subs).getAllByText(/status unknown/)).toHaveLength(1);
    expect(within(subs).getAllByRole('listitem')).toHaveLength(4);
    expect(subs).toHaveTextContent('3 older subagent transcript(s) not read.');
    expect(screen.getByTestId('session-log-header')).toHaveTextContent(SESSION_UUID);
    expect(screen.getByTestId('session-log-header')).toHaveTextContent('2.0 KB');
    expect(screen.getByTestId('session-log-truncated')).toHaveTextContent(
      'Earlier activity not shown: these are the most recent 4 entries within the read limits.',
    );
    expect(screen.getByTestId('session-earlier')).toHaveTextContent(`claude --resume ${OLDER}`);
    expect(screen.getByTestId('session-earlier')).not.toHaveTextContent(SESSION_UUID);
  });

  it('collapses long results and shows content as plain text (AC9)', async () => {
    data.sessionLog = found();
    await open(withSession(), 'Session');
    const list = await screen.findByRole('list', { name: 'Session timeline' });
    const result = must(within(list).getAllByRole('listitem')[2]);
    expect(result).toHaveTextContent('12 passed');
    expect(result).not.toHaveTextContent('second line of output');
    const more = within(result).getByRole('button', {
      name: 'Show more: result from main, 3m ago',
    });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    const body = must(document.getElementById(must(more.getAttribute('aria-controls'))));
    expect(body).toHaveTextContent('12 passed');
    fireEvent.click(more);
    expect(result).toHaveTextContent('second line of output');
    const less = within(result).getByRole('button', {
      name: 'Show less: result from main, 3m ago',
    });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(less);
    expect(result).not.toHaveTextContent('second line of output');
    // Each toggle names its own entry.
    const names = screen
      .getAllByRole('button', { name: /^Show more/ })
      .map((b) => b.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
    const userItem = must(within(list).getAllByRole('listitem')[3]);
    expect(userItem).toHaveTextContent('<b>bold</b> **not markdown** <img src=x onerror=alert(1)>');
    expect(userItem.querySelector('b, img, strong')).toBeNull();
  });

  it('refetches on the poll only while shown', async () => {
    data.sessionLog = found();
    const f = await open(withSession(), 'Events (0)');
    await new Promise((r) => setTimeout(r, 200));
    expect(logCalls(f)).toBe(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Session' }));
    await waitFor(() => {
      expect(logCalls(f)).toBeGreaterThanOrEqual(3);
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Events (0)' }));
    const stopped = logCalls(f);
    await new Promise((r) => setTimeout(r, 250));
    expect(logCalls(f)).toBe(stopped);
  });
});

describe('Job detail: Git tab', () => {
  const pr = 'https://github.com/x/y/pull/9';
  const mergedHead = 'abcdef0123456789abcdef0123456789abcdef01';
  const branchCommit = { sha: '1111111122222222', subject: 'Add the export button' };
  type Worktree = NonNullable<NonNullable<JobDetailView['plan']>['worktree']>;
  type Merge = NonNullable<JobDetailView['merge']>;
  function worktree(over: Partial<Worktree> = {}): Worktree {
    return {
      path: '/wt/g',
      exists: true,
      isWorktree: true,
      branch: 'factory/job-00000003-gamma',
      head: '9999999988888888',
      dirty: [],
      baseRef: 'origin/main',
      ahead: 0,
      behind: 6,
      commits: [],
      changedFiles: [],
      changes: [],
      fingerprint: 'fp',
      ...over,
    };
  }
  function merge(over: Partial<Merge> = {}): Merge {
    return {
      base: 'main',
      prUrl: pr,
      head: mergedHead,
      mergeCommit: null,
      verified: null,
      historyKnown: false,
      commits: [],
      changedFiles: [],
      outstanding: [],
      ...over,
    };
  }
  function show(wt: Worktree | null, m: Merge | null) {
    mockFetch();
    const base = detail();
    data.detail = detail({
      job: { ...base.job, prUrl: m ? pr : null, prState: m ? 'merged' : null },
      // PR hrefs come only from the read model's checked `links.pr` (todo 0019).
      links: { ...base.links, pr: m ? pr : null },
      plan: (wt
        ? { step: 'done', reason: '', agents: [], artifacts: [], worktree: wt }
        : null) as unknown as JobDetailView['plan'],
      planError: null,
      merge: m,
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
  }
  async function gitTab(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('tab', { name: 'Git' }));
    return must(screen.getByText(/^Worktree|^No worktree on disk/).parentElement);
  }

  it('says Merged into the base with the PR and merged head, and nothing outstanding (AC1, AC2)', async () => {
    show(worktree(), merge());
    const tab = await gitTab();
    expect(tab).toHaveTextContent(/Merged into main/);
    expect(within(tab).getByRole('link', { name: pr })).toHaveAttribute('href', pr);
    expect(tab).toHaveTextContent('abcdef01');
    expect(tab).not.toHaveTextContent(/ahead|behind/);
    expect(tab).toHaveTextContent('Nothing outstanding since the merge.');
    expect(tab).not.toHaveTextContent(/None yet|Commits on the branch|Changed files vs base/);
    expect(tab).not.toHaveTextContent(/Commits merged|Files changed/);
  });

  it('lists recorded history when known, and hides its headings when not (AC3)', async () => {
    show(
      worktree(),
      merge({ historyKnown: true, commits: [branchCommit], changedFiles: ['src/export.ts'] }),
    );
    const tab = await gitTab();
    expect(within(tab).getByText('Commits merged')).toBeInTheDocument();
    expect(tab).toHaveTextContent('11111111 Add the export button');
    expect(within(tab).getByText('Files changed')).toBeInTheDocument();
    expect(within(tab).getByText('src/export.ts')).toBeInTheDocument();
  });

  it('keeps ahead/behind, commits, and files for an unmerged branch; hides empty headings (AC6)', async () => {
    show(
      worktree({ ahead: 1, behind: 2, commits: [branchCommit], changedFiles: ['src/export.ts'] }),
      null,
    );
    let tab = await gitTab();
    expect(tab).toHaveTextContent('1 ahead / 2 behind origin/main');
    expect(within(tab).getByText('Commits on the branch')).toBeInTheDocument();
    expect(tab).toHaveTextContent('11111111 Add the export button');
    expect(within(tab).getByText('Changed files vs base')).toBeInTheDocument();
    expect(tab).not.toHaveTextContent(/Merged into/);
    cleanup();
    show(worktree({ behind: 0 }), null);
    tab = await gitTab();
    expect(tab).toHaveTextContent('0 ahead / 0 behind origin/main');
    expect(tab).not.toHaveTextContent(/None yet|Commits on the branch|Changed files vs base/);
  });

  it('shows the merged summary when the worktree was removed after the merge (AC7, AC8)', async () => {
    show(null, merge({ outstanding: null }));
    const tab = await gitTab();
    expect(tab).toHaveTextContent(/Merged into main/);
    expect(within(tab).getByRole('link', { name: pr })).toBeInTheDocument();
    expect(tab).toHaveTextContent(/No worktree on disk/);
    expect(tab).not.toHaveTextContent(/Nothing outstanding/);
  });

  it('still warns about uncommitted files on a merged job (AC8)', async () => {
    show(worktree({ dirty: ['notes.txt'] }), merge());
    const tab = await gitTab();
    expect(within(tab).getByText('Uncommitted: notes.txt')).toBeInTheDocument();
    expect(tab).not.toHaveTextContent(/Nothing outstanding/);
  });

  it('after a squash merge, ignores the branch comparison and lists only outstanding commits (AC10)', async () => {
    const wt = worktree({ ahead: 2, behind: 1, commits: [branchCommit] });
    show(wt, merge());
    let tab = await gitTab();
    expect(tab).not.toHaveTextContent(/ahead|behind/);
    expect(tab).not.toHaveTextContent('Add the export button');
    expect(tab).toHaveTextContent('Nothing outstanding since the merge.');
    cleanup();
    const later = { sha: '3333333344444444', subject: 'Follow-up fix' };
    show(wt, merge({ outstanding: [later] }));
    tab = await gitTab();
    expect(within(tab).getByText('Commits since the merge')).toBeInTheDocument();
    expect(tab).toHaveTextContent('33333333 Follow-up fix');
    expect(tab).not.toHaveTextContent(/Nothing outstanding|Add the export button/);
  });

  it('with an unknown merged head, shows only the merge and uncommitted files (AC11)', async () => {
    const wt = worktree({ ahead: 2, commits: [branchCommit], dirty: ['notes.txt'] });
    show(wt, merge({ head: null, outstanding: null }));
    const tab = await gitTab();
    expect(tab).toHaveTextContent(/Merged into main/);
    expect(within(tab).getByText('Uncommitted: notes.txt')).toBeInTheDocument();
    expect(tab).not.toHaveTextContent(/Nothing outstanding|ahead|behind|Add the export button/);
  });
});

describe('Loading and refresh progress', () => {
  const refreshing = () => screen.queryByRole('progressbar', { name: 'Refreshing' });

  it('shows a progress bar, not text, until the first board response', async () => {
    const gate = Promise.withResolvers<undefined>();
    hold.board = gate.promise;
    mockFetch();
    mount();
    expect(await screen.findByRole('progressbar', { name: 'Loading jobs' })).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(refreshing()).not.toBeInTheDocument();
    // No counts until the first response: bare labels, never zeros that look real.
    expect(
      within(screen.getByLabelText('Summary'))
        .getAllByRole('button')
        .map((c) => c.textContent),
    ).toEqual(['running', 'stale', 'need human', 'failed', 'idle']);
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveDisplayValue('current');
    hold = {};
    gate.resolve(undefined);
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(screen.queryByRole('progressbar', { name: 'Loading jobs' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveDisplayValue('current (4)');
  });

  it('shows Refreshing under the app bar only while a board poll is in flight', async () => {
    mockFetch();
    mount(200);
    await screen.findByRole('table', { name: 'Factory jobs' });
    await waitFor(() => {
      expect(refreshing()).not.toBeInTheDocument();
    });
    const ok = Promise.withResolvers<undefined>();
    hold.board = ok.promise;
    expect(await screen.findByRole('progressbar', { name: 'Refreshing' })).toBeInTheDocument();
    hold = {};
    ok.resolve(undefined);
    await waitFor(() => {
      expect(refreshing()).not.toBeInTheDocument();
    });
    // A failed poll clears it too.
    const bad = Promise.withResolvers<undefined>();
    hold.board = bad.promise;
    expect(await screen.findByRole('progressbar', { name: 'Refreshing' })).toBeInTheDocument();
    bad.reject(new Error('network down'));
    // Keep polls failing until the alert is seen: a 200 ms poll that succeeds first clears it.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('network down');
    });
    hold = {};
    await waitFor(() => {
      expect(refreshing()).not.toBeInTheDocument();
    });
  });

  it('shows a progress bar until the first detail response, then Refreshing for its polls', async () => {
    const first = Promise.withResolvers<undefined>();
    hold.detail = first.promise;
    const f = mockFetch();
    const boardCalls = () => (f.mock.calls as [string][]).filter(([u]) => u === '/api/jobs').length;
    window.location.hash = '#/jobs/job-00000003';
    mount(200);
    expect(
      await screen.findByRole('progressbar', { name: 'Loading job-00000003' }),
    ).toBeInTheDocument();
    // A board poll in flight during the detail's first load never adds a second bar.
    await waitFor(() => {
      expect(boardCalls()).toBeGreaterThanOrEqual(2);
    });
    const board = Promise.withResolvers<undefined>();
    hold.board = board.promise;
    const before = boardCalls();
    await waitFor(() => {
      expect(boardCalls()).toBeGreaterThan(before);
    });
    expect(refreshing()).not.toBeInTheDocument();
    hold = {};
    board.resolve(undefined);
    first.resolve(undefined);
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(
      screen.queryByRole('progressbar', { name: 'Loading job-00000003' }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(refreshing()).not.toBeInTheDocument();
    });
    const poll = Promise.withResolvers<undefined>();
    hold.detail = poll.promise;
    expect(await screen.findByRole('progressbar', { name: 'Refreshing' })).toBeInTheDocument();
    hold = {};
    poll.resolve(undefined);
    await waitFor(() => {
      expect(refreshing()).not.toBeInTheDocument();
    });
  });
});

describe('Likely flaky test', () => {
  const reason =
    'web/src/App.test.tsx > Loading and refresh progress > shows Refreshing under the app bar only while a board poll is in flight failed in run 12 at abc1234; the job did not change web/src/App.test.tsx';
  const flake = {
    runId: 12,
    head: 'abc1234def',
    check: 'check',
    tests: [
      {
        file: 'web/src/App.test.tsx',
        name: 'Loading and refresh progress > shows Refreshing under the app bar only while a board poll is in flight',
      },
    ],
    rule: 'unchanged-file' as const,
    reason,
    at: '2026-11-18T00:00:00.000Z',
    sharedWith: [] as string[],
  };

  it('names the test on the board row only when the server flags one', async () => {
    mockFetch();
    data.rows = [row({ id: 'job-00000001', title: 'Flaky', flake }), row({ id: 'job-00000002' })];
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(
      within(boardRowOf('job-00000001')).getByText(`Likely flaky test: ${reason}`),
    ).toBeVisible();
    expect(boardRowOf('job-00000002').querySelector('[data-flake]')).toBeNull();
  });

  it('says once that the same test fails in other jobs, on the row and in the detail', async () => {
    mockFetch();
    const shared = { ...flake, sharedWith: ['job-00000002'] };
    const text = `Likely machine-wide flaky test (also failing in job-00000002): ${reason}`;
    data.rows = [row({ id: 'job-00000001', title: 'Flaky', flake: shared })];
    const { unmount } = mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(within(boardRowOf('job-00000001')).getByText(text)).toBeVisible();
    unmount();
    data.detail = detail({ flake: shared });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    expect(await screen.findByText(text)).toBeVisible();
  });

  it('names the test in the job detail status panel, and nothing without a flag', async () => {
    mockFetch();
    data.detail = detail({ flake });
    window.location.hash = '#/jobs/job-00000003';
    const { unmount } = mount();
    expect(await screen.findByText(`Likely flaky test: ${reason}`)).toBeVisible();
    unmount();
    data.detail = detail();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(document.querySelector('[data-flake]')).toBeNull();
  });
});

describe('Job detail: navigable PR, commit, and log references (todo 0019)', () => {
  const repo = 'https://github.com/acme/alpha';
  const pr = 'https://github.com/acme/alpha/pull/7';
  const sha = (c: string) => c.repeat(40);
  // Branch commits, newest first: c4 is local only, c3 was pushed, c2 and c1 are older.
  const c1 = sha('1');
  const c2 = sha('2');
  const c3 = sha('3');
  const c4 = sha('4');
  const ciHead = sha('5');
  const base1 = sha('b');
  const base0 = sha('e');
  const commitName = (s: string) => `Commit ${s.slice(0, 8)} on GitHub`;
  const external = (a: Element) => {
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noreferrer noopener');
  };
  type Plan = NonNullable<JobDetailView['plan']>;
  const check = (id: number, checkId: string, outputPath: string) => ({
    id,
    checkId,
    command: 'npm',
    args: [],
    cwd: '.',
    status: 'passed',
    required: true,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    outputPath,
    truncated: false,
  });
  const integration = {
    id: 3,
    status: 'clean',
    fromHead: c3,
    baseRef: 'origin/main',
    baseSha: base1,
    resultHead: c4,
    conflicts: [],
    material: [],
    changedFiles: [],
  };
  const verification = {
    configured: true,
    policy: {
      source: 'authorized',
      head: c4,
      fingerprint: 'fp',
      checks: ['check'],
      authorization: 'not-needed',
      candidateError: null,
    },
    run: {
      id: 12,
      status: 'passed',
      head: c3,
      checks: [check(1, 'check', 'verification/12/check.log'), check(2, 'abs', '/abs/x.log')],
    },
    valid: true,
    reason: null,
    queue: null,
  };
  function rich(
    over: Partial<JobDetailView> = {},
    plan: Partial<Record<'integration' | 'verification', unknown>> = {},
  ): JobDetailView {
    const b = detail();
    return detail({
      job: { ...b.job, repo: 'github.com/acme/alpha', prUrl: pr, prState: 'draft', ciHead },
      links: {
        ...b.links,
        pr,
        repo,
        pushedHeads: [c3],
        // What the server's isLogPath accepts of the paths below (tests/server.test.ts).
        logs: Object.fromEntries(
          ['ci/5555555/test.log', 'verification/12/check.log'].map((l) => [
            l,
            `/api/jobs/${b.job.id}/artifacts/${l}`,
          ]),
        ),
      },
      actions: ['merge'],
      ci: noCi({
        head: ciHead,
        status: 'failing',
        outcome: 'failing',
        checkedAt: b.job.updatedAt,
        line: `CI failing for ${pr}.`,
        guidance: `Read ${pr}, then rework.`,
        failures: [
          {
            name: 'test',
            conclusion: 'failure',
            url: `${repo}/actions/runs/1`,
            log: 'ci/5555555/test.log',
          },
          { name: 'lint', conclusion: 'failure', url: 'javascript:alert(1)', log: '..\\x.log' },
          { name: 'abs', conclusion: 'failure', url: null, log: '/abs/x.log' },
          { name: 'drive', conclusion: 'failure', url: null, log: 'C:\\x.log' },
          { name: 'notes', conclusion: 'failure', url: null, log: 'notes.txt' },
        ],
      }),
      plan: {
        step: 'run-agent',
        reason: `Waiting on (${pr}).`,
        agents: [],
        artifacts: [],
        worktree: {
          path: '/wt/g',
          exists: true,
          isWorktree: true,
          branch: 'factory/x',
          head: c4,
          dirty: [],
          baseRef: 'origin/main',
          ahead: 4,
          behind: 0,
          commits: [
            { sha: c4, subject: 'Local only' },
            { sha: c3, subject: 'Pushed head' },
            { sha: c2, subject: 'Older two' },
            { sha: c1, subject: 'Older one' },
          ],
          changedFiles: [],
          changes: [],
          fingerprint: 'fp',
        },
        verification,
        sensitive: null,
        integration,
        ...plan,
      } as unknown as Plan,
      planError: null,
      ...over,
    });
  }
  async function view(d: JobDetailView) {
    mockFetch();
    data.detail = d;
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
  }
  const tab = async (name: RegExp) => {
    fireEvent.click(await screen.findByRole('tab', { name }));
  };
  const hrefs = () =>
    [...document.querySelectorAll('[href]')].map((a) => a.getAttribute('href') ?? '');

  it('links every PR reference to links.pr: button, header, Overview, PR tab, and merge dialog', async () => {
    await view(rich());
    external(screen.getByRole('link', { name: 'Open PR on GitHub' }));
    expect(screen.getByRole('link', { name: 'Open PR on GitHub' })).toHaveAttribute('href', pr);
    const num = within(screen.getByTestId('job-header')).getByRole('link', { name: 'PR #7' });
    expect(num).toHaveAttribute('href', pr);
    external(num);
    // Overview: "(<pr>)." with the brackets and the full stop outside the link.
    const step = must(screen.getByText(/Next step:/).closest('p'));
    const inStep = within(step).getByRole('link', { name: pr });
    expect(inStep).toHaveAttribute('href', pr);
    external(inStep);
    expect(step).toHaveTextContent(`Waiting on (${pr}).`);
    await tab(/^PR/);
    const panel = screen.getByTestId('ci-panel');
    const inPanel = within(panel).getAllByRole('link', { name: pr });
    expect(inPanel).toHaveLength(2); // ci.line and ci.guidance
    for (const a of inPanel) {
      expect(a).toHaveAttribute('href', pr);
      external(a);
    }
    // The PR tab's URL line, plus the two in the CI panel.
    const prTab = screen.getByRole('tabpanel');
    expect(within(prTab).getAllByRole('link', { name: pr })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByTestId('merge-confirm');
    const inDialog = within(confirm).getByRole('link', { name: pr });
    expect(inDialog).toHaveAttribute('href', pr);
    external(inDialog);
  });

  it('links the PR in the status Next line and in a ci blocker summary', async () => {
    await view(rich({ blocker: { kind: 'ci', summary: 'CI still failing', detail: null } }));
    const next = screen.getByTestId('status-next');
    expect(within(next).getByRole('link', { name: pr })).toHaveAttribute('href', pr);
    expect(next).toHaveTextContent(`Next: Read ${pr}, then rework.`);
    const summary = screen.getByTestId('status-summary');
    expect(within(summary).getByRole('link', { name: pr })).toHaveAttribute('href', pr);
    expect(summary).toHaveTextContent(`CI failing for ${pr}.`);
  });

  it('PR tab: links the CI head, the saved log, and an https GitHub log; refuses the rest', async () => {
    await view(rich());
    await tab(/^PR/);
    const panel = screen.getByTestId('ci-panel');
    const head = within(panel).getByRole('link', { name: commitName(ciHead) });
    expect(head).toHaveAttribute('href', `${repo}/commit/${ciHead}`);
    expect(head).toHaveTextContent(ciHead.slice(0, 8));
    expect(head.querySelector('code')).not.toBeNull();
    external(head);
    const saved = within(panel).getByRole('link', { name: 'Saved log ci/5555555/test.log' });
    expect(saved).toHaveAttribute('href', '/api/jobs/job-00000003/artifacts/ci/5555555/test.log');
    external(saved);
    const gh = within(panel).getAllByRole('link', { name: 'GitHub log' });
    expect(gh).toHaveLength(1); // the javascript: URL is not an href
    expect(gh[0]).toHaveAttribute('href', `${repo}/actions/runs/1`);
    for (const bad of ['..\\x.log', '/abs/x.log', 'C:\\x.log', 'notes.txt']) {
      expect(panel).toHaveTextContent(`saved ${bad} under the artifact directory`);
    }
    expect(hrefs().some((h) => h.trim().toLowerCase().startsWith('javascript:'))).toBe(false);
    expect(hrefs().filter((h) => h.startsWith('/api/'))).toEqual([
      '/api/jobs/job-00000003/artifacts/ci/5555555/test.log',
    ]);
  });

  it('Git tab: links the pushed head and the older commits only, never a local-only one (R3 b)', async () => {
    await view(rich());
    await tab(/^Git/);
    const git = must(screen.getByText(/^Worktree/).parentElement);
    for (const s of [c3, c2, c1]) {
      const a = within(git).getByRole('link', { name: commitName(s) });
      expect(a).toHaveAttribute('href', `${repo}/commit/${s}`);
      external(a);
    }
    expect(within(git).queryByRole('link', { name: commitName(c4) })).toBeNull();
    expect(git).toHaveTextContent(`HEAD ${c4.slice(0, 10)}`); // the worktree HEAD is c4
    expect(git).toHaveTextContent('33333333 Pushed head');
    expect(git).toHaveTextContent('44444444 Local only');
  });

  it('Git tab: the pushed head comes from links.pushedHeads, not the capped events (ticket 0079)', async () => {
    await view(rich({ events: [] }));
    await tab(/^Git/);
    const git = must(screen.getByText(/^Worktree/).parentElement);
    expect(within(git).getByRole('link', { name: commitName(c3) })).toHaveAttribute(
      'href',
      `${repo}/commit/${c3}`,
    );
    expect(within(git).queryByRole('link', { name: commitName(c4) })).toBeNull();
    expect(git).toHaveTextContent('44444444 Local only');
  });

  it('Git tab after a merge: the PR, merged head and commits linked; since-the-merge by R3 b', async () => {
    const [m1, m0, o3, o2, o1] = [sha('a'), sha('9'), sha('8'), sha('7'), sha('6')];
    const d = rich();
    d.job = { ...d.job, prState: 'merged' };
    d.links = { ...d.links, pushedHeads: [o2] };
    d.merge = {
      base: 'main',
      prUrl: pr,
      head: m1,
      mergeCommit: null,
      verified: null,
      historyKnown: true,
      commits: [
        { sha: m1, subject: 'Merged one' },
        { sha: m0, subject: 'Merged zero' },
      ],
      changedFiles: [],
      outstanding: [
        { sha: o3, subject: 'Local follow-up' },
        { sha: o2, subject: 'Pushed follow-up' },
        { sha: o1, subject: 'Older follow-up' },
      ],
    };
    await view(d);
    await tab(/^Git/);
    const git = must(screen.getByText(/^Worktree/).parentElement);
    expect(within(git).getByRole('link', { name: pr })).toHaveAttribute('href', pr);
    // "at <merge.head>" and "Commits merged" both link m1.
    expect(within(git).getAllByRole('link', { name: commitName(m1) })).toHaveLength(2);
    for (const s of [m1, m0, o2, o1]) {
      for (const a of within(git).getAllByRole('link', { name: commitName(s) })) {
        expect(a).toHaveAttribute('href', `${repo}/commit/${s}`);
      }
    }
    expect(within(git).queryByRole('link', { name: commitName(o3) })).toBeNull();
    expect(git).toHaveTextContent('88888888 Local follow-up');
  });

  it('Verification tab: log links, heads by R3, the base commit only from origin (R3 c)', async () => {
    await view(rich());
    await tab(/^Verification/);
    const panel = screen.getByRole('tabpanel');
    const log = within(panel).getByRole('link', { name: 'verification/12/check.log' });
    expect(log).toHaveAttribute(
      'href',
      '/api/jobs/job-00000003/artifacts/verification/12/check.log',
    );
    external(log);
    expect(within(panel).queryByRole('link', { name: '/abs/x.log' })).toBeNull();
    expect(panel).toHaveTextContent('/abs/x.log');
    // Run head and fromHead are the pushed c3; the authorized policy head and resultHead c4 are not.
    expect(within(panel).getAllByRole('link', { name: commitName(c3) })).toHaveLength(2);
    expect(within(panel).queryByRole('link', { name: commitName(c4) })).toBeNull();
    expect(panel).toHaveTextContent(c4.slice(0, 10));
    expect(within(panel).getByRole('link', { name: commitName(base1) })).toHaveAttribute(
      'href',
      `${repo}/commit/${base1}`,
    );
    cleanup();

    // A local base ref has no known remote copy; a baseline policy head follows the worktree's
    // base ref (origin/main here).
    await view(
      rich(
        {},
        {
          integration: { ...integration, baseRef: 'main' },
          verification: {
            ...verification,
            policy: { ...verification.policy, source: 'baseline', head: base0 },
          },
        },
      ),
    );
    await tab(/^Verification/);
    const p2 = screen.getByRole('tabpanel');
    expect(within(p2).queryByRole('link', { name: commitName(base1) })).toBeNull();
    expect(p2).toHaveTextContent(base1.slice(0, 10));
    expect(within(p2).getByRole('link', { name: commitName(base0) })).toHaveAttribute(
      'href',
      `${repo}/commit/${base0}`,
    );
  });

  it('builds no commit link without links.repo and no PR link without links.pr', async () => {
    const d = rich();
    await view({ ...d, links: { ...d.links, repo: null, pr: null } });
    expect(screen.queryByRole('link', { name: 'Open PR on GitHub' })).toBeNull();
    const h = screen.getByTestId('job-header');
    expect(within(h).queryByRole('link', { name: 'PR #7' })).toBeNull();
    expect(h).toHaveTextContent('PR #7');
    for (const t of [/^Overview/, /^PR/, /^Git/, /^Verification/]) {
      await tab(t);
      expect(screen.queryByRole('link', { name: /^Commit / })).toBeNull();
      expect(screen.queryByRole('link', { name: pr })).toBeNull();
      expect(hrefs().some((x) => x.includes('/commit/') || x === pr)).toBe(false);
    }
    expect(screen.getByRole('tabpanel')).toHaveTextContent(c3.slice(0, 10));
  });

  it('every external or artifact-route link opens a new tab without referrer or opener', async () => {
    await view(rich());
    for (const t of [/^Overview/, /^PR/, /^Git/, /^Verification/]) {
      await tab(t);
      const as = document.querySelectorAll('a[href^="http"], a[href^="/api/"]');
      expect(as.length).toBeGreaterThan(0);
      for (const a of as) external(a);
      expect(hrefs().some((x) => x.trim().toLowerCase().startsWith('javascript:'))).toBe(false);
    }
  });

  // Ticket 0027: the run history. Run 11 took 9m 06s; its head c2 is older than the pushed c3.
  const earlierLog = 'verification/11/check.log';
  const run = (id: number, status: string, head: string, checks: ReturnType<typeof check>[]) => ({
    id,
    jobId: 'job-00000003',
    head,
    tree: 't',
    dirty: [],
    configFingerprint: 'fp',
    policySource: 'baseline',
    policyHead: null,
    status,
    actor: null,
    startedAt: '2026-11-13T08:00:00.000Z',
    completedAt: '2026-11-13T08:09:06.218Z',
    checks,
  });
  const latestRun = run(12, 'passed', c3, [
    { ...check(1, 'check', 'verification/12/check.log'), durationMs: 546218 },
  ]);
  const earlierRun = run(11, 'passed', c2, [{ ...check(3, 'check', earlierLog), cwd: 'web' }]);
  function history(
    v: unknown = { ...verification, run: latestRun },
    earlier: unknown = earlierRun,
  ): JobDetailView {
    const d = rich({}, { verification: v });
    return {
      ...d,
      verificationRuns: [latestRun, earlier] as unknown as JobDetailView['verificationRuns'],
      links: {
        ...d.links,
        logs: { ...d.links.logs, [earlierLog]: `/api/jobs/${d.job.id}/artifacts/${earlierLog}` },
      },
    };
  }
  const earlierSummary = () =>
    within(screen.getByTestId('earlier-runs')).getByRole('button', { name: /#11/ });

  it('Verification tab: the latest run expanded, an earlier run collapsed until opened (ticket 0027)', async () => {
    await view(history());
    await tab(/^Verification/);
    const panel = screen.getByRole('tabpanel');
    // The latest run as before, with a formatted duration and no "in ." for the root.
    expect(panel).toHaveTextContent(/Latest run: #12\s*passed at 33333333, valid for HEAD/);
    const latest = within(panel).getByRole('table', { name: 'Verification checks of run 12' });
    expect(within(latest).getByRole('columnheader', { name: 'Duration' })).toBeInTheDocument();
    expect(within(latest).queryByRole('columnheader', { name: 'ms' })).toBeNull();
    expect(latest).toHaveTextContent('9m 06s');
    const command = must(within(latest).getByText('npm').closest('td'));
    expect(command.textContent).toBe('npm');
    expect(panel.textContent.match(/valid for HEAD/g)).toHaveLength(1);

    // The earlier run: id, status, when, how long, and its tested head; no checks yet.
    const summary = earlierSummary();
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect(summary).toHaveTextContent('#11');
    expect(summary).toHaveTextContent('passed');
    expect(summary).toHaveTextContent('took 9m 06s');
    expect(summary).not.toHaveTextContent(/valid|stale/);
    const time = must(summary.querySelector('time'));
    expect(time).toHaveAttribute('dateTime', '2026-11-13T08:09:06.218Z');
    expect(time).toHaveAttribute('title', localTime('2026-11-13T08:09:06.218Z'));
    expect(time).toHaveTextContent(/ago$/);
    // The collapsed row names the tested commit as text: a button holds no link (or any other
    // focusable element), so the commit link is absent until the run is opened.
    expect(summary).toHaveTextContent(`at ${c2.slice(0, 10)}`);
    expect(within(summary).queryByRole('link')).toBeNull();
    expect(summary.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull();
    const earlier = screen.getByTestId('earlier-runs');
    expect(within(earlier).queryByRole('link', { name: commitName(c2) })).toBeNull();
    expect(
      within(panel).queryByRole('table', { name: 'Verification checks of run 11' }),
    ).toBeNull();
    expect(panel).not.toHaveTextContent(earlierLog);

    // Keyboard: the summary is focusable, and Enter opens it.
    expect(summary).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(summary, { key: 'Enter' });
    expect(earlierSummary()).toHaveAttribute('aria-expanded', 'true');
    // Opened: the tested commit is a link beside the checks, outside the summary button.
    const link = within(earlier).getByRole('link', { name: commitName(c2) });
    expect(link).toHaveAttribute('href', `${repo}/commit/${c2}`);
    external(link);
    expect(earlierSummary().contains(link)).toBe(false);
    const opened = within(panel).getByRole('table', { name: 'Verification checks of run 11' });
    expect(must(within(opened).getByText('npm').closest('td')).textContent).toBe('npm in web');
    const log = within(opened).getByRole('link', { name: earlierLog });
    expect(log).toHaveAttribute('href', `/api/jobs/job-00000003/artifacts/${earlierLog}`);
    external(log);
  });

  it('Verification tab: a passed earlier run makes no validity claim when the latest is not valid', async () => {
    await view(
      history({
        ...verification,
        run: { ...latestRun, status: 'failed' },
        valid: false,
        reason: 'a required check failed',
      }),
    );
    await tab(/^Verification/);
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('stale: a required check failed');
    expect(panel).not.toHaveTextContent('valid for HEAD');
    const summary = earlierSummary();
    expect(summary).toHaveTextContent('passed');
    expect(summary).not.toHaveTextContent(/valid|stale/);
    expect(summary.querySelector('.MuiChip-colorSuccess')).toBeNull();
    expect(summary.querySelector('.MuiChip-colorDefault')).not.toBeNull();
  });

  it('Verification tab without a worktree: runs listed, no validity text, not labelled empty', async () => {
    // The earlier run never completed: its row says when it started and claims no duration.
    const d = history(null, { ...earlierRun, status: 'running', completedAt: null });
    expect(detailTabs(d).find((t) => t.name === 'Verification')?.label).toBe('Verification');
    await view(d);
    fireEvent.click(screen.getByRole('tab', { name: 'Verification' }));
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent(/Latest run: #12\s*passed at 33333333/);
    expect(
      within(panel).getByRole('table', { name: 'Verification checks of run 12' }),
    ).toBeVisible();
    expect(earlierSummary()).toHaveAttribute('aria-expanded', 'false');
    expect(earlierSummary()).toHaveTextContent(/started .* ago/);
    expect(earlierSummary()).not.toHaveTextContent('took');
    expect(must(earlierSummary().querySelector('time'))).toHaveAttribute(
      'dateTime',
      '2026-11-13T08:00:00.000Z',
    );
    expect(panel).not.toHaveTextContent(/valid for HEAD|stale:|No worktree; nothing verified\./);
    // The run's own chip claims nothing; only a passed check inside the table is green.
    const line = within(panel).getByText(/Latest run:/);
    expect(line.querySelector('.MuiChip-colorSuccess')).toBeNull();
    expect(line.querySelector('.MuiChip-colorDefault')).not.toBeNull();
    cleanup();

    const none = { ...d, verificationRuns: [] };
    expect(detailTabs(none).find((t) => t.name === 'Verification')?.label).toBe(
      'Verification (empty)',
    );
    await view(none);
    fireEvent.click(screen.getByRole('tab', { name: 'Verification (empty)' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No worktree; nothing verified.');
  });
});

describe('prParts (R6)', () => {
  const pr = 'https://github.com/acme/alpha/pull/7';
  const links = (text: string) => prParts(text, pr).filter((p) => typeof p !== 'string');

  it('links only bounded occurrences and keeps the punctuation outside', () => {
    expect(prParts(`See ${pr}.`, pr)).toEqual(['See ', { pr }, '.']);
    expect(prParts(`(${pr})`, pr)).toEqual(['(', { pr }, ')']);
    expect(prParts(`"${pr}", '${pr}'; [${pr}]!`, pr)).toEqual([
      '"',
      { pr },
      '", \'',
      { pr },
      "'; [",
      { pr },
      ']!',
    ]);
    expect(links(`${pr}/files`)).toHaveLength(0);
    expect(links(`${pr}0`)).toHaveLength(0);
    expect(links(`x${pr}`)).toHaveLength(0);
    expect(prParts(`${pr}/files and ${pr}`, pr)).toEqual([`${pr}/files and `, { pr }]);
    expect(prParts('no url', null)).toEqual(['no url']);
  });

  it('makes at most three links; later occurrences stay text', () => {
    const text = `${pr} ${pr} ${pr} ${pr}`;
    expect(links(text)).toHaveLength(3);
    expect(prParts(text, pr).at(-1)).toBe(` ${pr}`);
  });

  it('renders the bounded links only, each to links.pr, at most three', async () => {
    const b = detail();
    mockFetch();
    const reason = `a ${pr}. b (${pr}) c ${pr}/files d ${pr}0 e ${pr} f ${pr}`;
    data.detail = detail({
      links: { ...b.links, pr },
      plan: {
        step: 'run-agent',
        reason,
        agents: [],
        artifacts: [],
        worktree: null,
      } as unknown as JobDetailView['plan'],
      planError: null,
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    const step = must((await screen.findByText(/Next step:/)).closest('p'));
    const as = within(step).getAllByRole('link');
    expect(as).toHaveLength(3);
    for (const a of as) {
      expect(a).toHaveAttribute('href', pr);
      expect(a.textContent).toBe(pr);
    }
    expect(step).toHaveTextContent(reason);
  });
});

describe('reference helpers (R2, R8)', () => {
  it('builds commit hrefs only from a repo base and a lowercase hex SHA', () => {
    expect(commitHref('https://github.com/a/b', 'abcdef0')).toBe(
      'https://github.com/a/b/commit/abcdef0',
    );
    expect(commitHref(null, 'abcdef0')).toBeNull();
    expect(commitHref('https://github.com/a/b', 'abcdef')).toBeNull();
    expect(commitHref('https://github.com/a/b', 'ABCDEF0')).toBeNull();
    expect(commitHref('https://github.com/a/b', '../x')).toBeNull();
    expect(commitHref('https://github.com/a/b', 'a'.repeat(41))).toBeNull();
  });

  it('accepts only https for GitHub log URLs', () => {
    expect(httpsHref('https://github.com/a/b/actions/runs/1')).toBe(
      'https://github.com/a/b/actions/runs/1',
    );
    for (const bad of ['javascript:alert(1)', 'http://github.com/x', 'data:text/html,x', 'x', null])
      expect(httpsHref(bad)).toBeNull();
  });
});

describe('job to ticket', () => {
  it('links a job that works on a ticket to that ticket, and no other job', async () => {
    data.detail = detail({ job: { ...detail().job, ticketId: 85 } });
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    const view = mount();
    const header = await screen.findByTestId('job-header');
    expect(within(header).getByRole('link', { name: 'ticket 0085' })).toHaveAttribute(
      'href',
      '#/tickets/85',
    );
    view.unmount();
    data.detail = detail();
    mount();
    expect(
      within(await screen.findByTestId('job-header')).queryByRole('link', { name: /ticket/ }),
    ).toBeNull();
  });
});

describe('Fast jobs', () => {
  it('the board shows a fast chip on fast rows only', async () => {
    data.rows = [row({ id: 'job-0000000a', title: 'Quick fix', mode: 'fast' }), ...rows];
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(within(boardRowOf('job-0000000a')).getByText('fast')).toBeInTheDocument();
    expect(within(boardRowOf('job-00000001')).queryByText('fast')).toBeNull();
  });

  it('the detail header shows a fast chip for a fast job and none for a full job', async () => {
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.queryByText('fast')).toBeNull();
    cleanup();
    data.detail = detail({ job: { ...detail().job, mode: 'fast' } });
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText('fast').closest('[data-mode="fast"]')).toHaveAttribute(
      'title',
      expect.stringContaining('Fast job'),
    );
  });
});

describe('App help', () => {
  it('shows a ? Help button in the shared app bar on every section, and no footer', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(screen.getByRole('button', { name: 'Help' })).toHaveTextContent(/^\?$/);
    window.location.hash = '#/tickets';
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Tickets' })).toHaveAttribute('aria-current', 'page');
    });
    expect(screen.getByRole('button', { name: 'Help' })).toHaveTextContent(/^\?$/);
    expect(document.querySelector('footer')).toBeNull();
    expect(screen.queryByText(/Read from the shared orch database/)).toBeNull();
  });

  it('opens a grouped glossary with the refresh interval, and Escape returns focus to Help', async () => {
    mockFetch();
    mount(7000);
    await screen.findByRole('table', { name: 'Factory jobs' });
    const button = screen.getByRole('button', { name: 'Help' });
    // A real click focuses the button first; jsdom's synthetic click does not.
    button.focus();
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).not.toHaveFocus();
    });
    const help = await screen.findByRole('dialog', { name: 'Help' });
    for (const name of [
      'Stages',
      'Statuses',
      'Leases and stale',
      'Review rounds and CI repairs',
      'What the dashboard does not do',
    ]) {
      expect(within(help).getByRole('heading', { name })).toBeInTheDocument();
    }
    const group = (name: string) =>
      must(within(help).getByRole('heading', { name }).closest('section'));
    expect(help).toHaveTextContent('every 7s');
    const stages = group('Stages');
    expect([...stages.querySelectorAll('li')].map((li) => li.textContent)).toEqual(STEP_LABELS);
    expect(stages).toHaveTextContent(/needs human is a pause .*not a stage/);
    const statuses = [...group('Statuses').querySelectorAll('li')].map((li) => li.textContent);
    expect(statuses).toEqual(
      Object.values(STATE).map((s) => `${s.glyph} ${s.label}: ${s.describe}`),
    );
    expect(help).toHaveTextContent(STATE.stale.describe);
    const leases = group('Leases and stale');
    expect(leases).toHaveTextContent(/live lease is not proof that a process is alive/);
    expect(leases).toHaveTextContent(/lease lapsed without renewal/);
    const budgets = group('Review rounds and CI repairs');
    expect(budgets).toHaveTextContent(/Round r of max/);
    expect(budgets).toHaveTextContent(/Repairs n of max/);
    expect(budgets.textContent.match(/escalates to needs human/g)).toHaveLength(2);
    const nots = group('What the dashboard does not do');
    const bullets = [...nots.querySelectorAll('li')].map((li) => li.textContent);
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    expect(bullets.length).toBeLessThanOrEqual(5);
    expect(nots).toHaveTextContent(/Start, stop, or resume the factory controller/);
    expect(nots).toHaveTextContent(/Message/);
    expect(nots).toHaveTextContent(/Skip a gate, or merge without verification/);
    expect(nots).toHaveTextContent(/needs-human job waits for a person/);
    expect(help.querySelector('a')).toBeNull();
    fireEvent.keyDown(help, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument();
    });
    expect(button).toHaveFocus();
  });
});

describe('Job detail: Overview summary (ticket 0016)', () => {
  const at = (m: number) => `2026-11-13T08:${String(m).padStart(2, '0')}:00.000Z`;
  const review = (id: number, round: number, verdict: 'pass' | 'changes') => ({
    id,
    jobId: 'job-00000003',
    round,
    artifactId: id,
    head: 'abc',
    model: null,
    sameAsAuthor: null,
    reviewer: `r${String(id)}`,
    verdict,
    summary: null,
    path: null,
    createdAt: at(10),
    completedAt: at(11),
  });
  const verified = (run: { status: string; head: string } | null, valid: boolean, reason = '') =>
    ({
      step: 'run-agent',
      reason: 'Build the thing',
      agents: [{ agent: 'factory-builder', model: 'opus' }],
      artifacts: [],
      worktree: null,
      verification: {
        configured: true,
        policy: {
          source: 'baseline',
          head: null,
          fingerprint: 'fp',
          checks: ['check'],
          authorization: 'not-needed',
          candidateError: null,
        },
        run: run && { id: 4, checks: [], ...run },
        valid,
        reason: valid ? null : reason,
        queue: null,
      },
      sensitive: null,
      integration: null,
    }) as unknown as JobDetailView['plan'];
  /** Round 1 asked for changes and went back to Build; round 2 (current) passed. */
  function twoRounds(over: Partial<JobDetailView> = {}): JobDetailView {
    const b = detail();
    return detail({
      job: { ...b.job, stage: 'approve', status: 'pending', round: 2 },
      liveness: 'idle',
      blocker: null,
      progress: progress(4, 'current', 'Approve'),
      rounds: [
        {
          round: 1,
          reviews: [review(1, 1, 'changes'), review(2, 1, 'pass')],
          consolidated: 'round-1/consolidated.md',
          blocking: 0,
        },
        {
          round: 2,
          reviews: [review(3, 2, 'pass'), review(4, 2, 'pass')],
          consolidated: 'round-2/consolidated.md',
          blocking: 2,
        },
      ],
      timeline: {
        entries: [
          { at: at(1), step: 'spec', kind: 'completed', label: 'Spec completed' },
          {
            at: at(2),
            step: 'review',
            kind: 'back',
            label: 'Review round 1: changes requested, back to Build',
          },
          { at: at(3), step: 'review', kind: 'completed', label: 'Review round 2 passed' },
        ],
      },
      plan: verified({ status: 'passed', head: '1234567890abcdef' }, true),
      planError: null,
      ...over,
    });
  }
  async function view(d: JobDetailView) {
    mockFetch();
    data.detail = d;
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
  }
  const line = (id: string) => screen.queryByTestId(`summary-${id}`);
  const before = (a: Element, b: Element) => {
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  };

  it('reads Request, summary lines, Progress, Timeline, then the muted agent block (AC1)', async () => {
    await view(twoRounds());
    const panel = screen.getByRole('tabpanel');
    const request = within(panel).getByTestId('overview-request');
    expect(request).toHaveTextContent('Do the thing');
    const summary = within(panel).getByTestId('overview-summary');
    const progressSection = within(panel).getByTestId('progress-section');
    const timeline = within(progressSection).getByRole('table', { name: 'Timeline' });
    const agent = within(panel).getByRole('region', { name: 'For the agent session' });
    before(request, summary);
    before(summary, progressSection);
    before(within(progressSection).getByRole('list', { name: 'Workflow steps' }), timeline);
    before(timeline, agent);
    expect(within(agent).getByRole('heading', { name: 'For the agent session' })).toBeVisible();
    expect(agent).toHaveTextContent('Next step: run-agent — Build the thing');
    expect(agent).toHaveTextContent('Agents: factory-builder (opus)');
    expect(within(agent).getByTestId('drawn-models')).toBeInTheDocument();
    // Muted: the block is the theme's text.secondary, unlike the Request.
    const muted = theme.palette.text.secondary;
    expect(getComputedStyle(agent).color).toBe(muted);
    expect(getComputedStyle(request).color).not.toBe(muted);
  });

  it('summarises the current round only, the reworks, and the newest blocking count (AC2)', async () => {
    await view(twoRounds());
    const reviews = must(line('reviews'));
    expect(reviews).toHaveTextContent('Reviews: Round 2 of 3 2/2 pass 1 rework 2 blocking');
    expect(reviews).not.toHaveTextContent('changes');
    const chip = within(reviews).getByText('2/2 pass').closest('.MuiChip-root');
    expect(chip).toHaveClass('MuiChip-colorSuccess');
    expect(reviewRollup(twoRounds().rounds[1]?.reviews ?? [])?.color).toBe('success');
    cleanup();
    await view(twoRounds({ job: { ...detail().job, round: 0 }, rounds: [] }));
    expect(line('reviews')).toHaveTextContent('Reviews: No review round yet');
    cleanup();
    await view(twoRounds({ job: { ...detail().job, round: 2, mode: 'fast' } }));
    expect(line('reviews')).toBeNull();
  });

  it('states the latest run, its tested HEAD, and its validity from plan.verification (AC3)', async () => {
    await view(twoRounds());
    expect(line('verification')).toHaveTextContent(
      'Verification: passed at 1234567890, valid for HEAD',
    );
    cleanup();
    await view(
      twoRounds({
        plan: verified({ status: 'passed', head: '1234567890abcdef' }, false, 'HEAD moved'),
      }),
    );
    expect(line('verification')).toHaveTextContent('passed at 1234567890, stale: HEAD moved');
    cleanup();
    await view(twoRounds({ plan: verified(null, false, 'no verification run recorded') }));
    expect(line('verification')).toHaveTextContent('Verification: Not verified yet');
    cleanup();
    await view(twoRounds({ plan: null, planError: 'no worktree' }));
    expect(line('verification')).toBeNull();
  });

  it('shows the PR, its phase chip, and the CI line verbatim once a PR is recorded (AC4)', async () => {
    await view(twoRounds());
    expect(line('delivery')).toBeNull();
    cleanup();
    const pr = 'https://github.com/acme/alpha/pull/7';
    await view(
      twoRounds({
        job: { ...twoRounds().job, prUrl: pr, prState: 'draft' },
        links: { ...detail().links, pr },
        prPhase: 'draft',
        ci: noCi({ line: 'PR created; CI not yet observed.' }),
      }),
    );
    const delivery = must(line('delivery'));
    expect(within(delivery).getByRole('link', { name: pr })).toHaveAttribute('href', pr);
    expect(delivery.querySelector('[data-phase="draft"]')).not.toBeNull();
    expect(delivery).toHaveTextContent('PR created; CI not yet observed.');
  });

  it('links timeline entries to an available tab and leaves the rest plain (AC7)', async () => {
    await view(twoRounds());
    // No spec.md registered: the Spec tab is unavailable, so its entry is plain text.
    expect(screen.queryByRole('button', { name: /^Open Spec tab/ })).toBeNull();
    const timeline = screen.getByRole('table', { name: 'Timeline' });
    expect(within(timeline).getByText('Spec completed').closest('button')).toBeNull();
    const entry = screen.getByRole('button', { name: 'Open Reviews tab: Review round 2 passed' });
    fireEvent.click(entry);
    expect(screen.getByRole('tab', { name: /^Reviews/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('moves keyboard focus to the tab a timeline entry opens', async () => {
    await view(twoRounds());
    const entry = screen.getByRole('button', { name: 'Open Reviews tab: Review round 2 passed' });
    // A native button: the browser turns Enter into a click, which jsdom does not synthesize.
    expect(entry.tagName).toBe('BUTTON');
    entry.focus();
    expect(document.activeElement).toBe(entry);
    fireEvent.keyDown(entry, { key: 'Enter' });
    fireEvent.click(entry);
    const reviews = screen.getByRole('tab', { name: /^Reviews/ });
    expect(reviews).toHaveAttribute('aria-selected', 'true');
    expect(reviews).toHaveAttribute('id', 'tab-Reviews');
    expect(document.activeElement).toBe(reviews);
  });
});

describe('Deep links (ticket 0007)', () => {
  const go = (hash: string) => {
    window.location.hash = hash;
    fireEvent(window, new HashChangeEvent('hashchange'));
  };
  const select = (name: string) => screen.getByRole('combobox', { name });
  const filter = () => screen.getByRole('searchbox', { name: 'Filter' });
  const th = (name: string) => must(screen.getByRole('button', { name }).closest('th'));
  const sorted = () => document.querySelectorAll('th[aria-sort]');
  const jobsNav = () =>
    within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', {
      name: 'Jobs',
    });
  const brand = () => screen.getByRole('link', { name: 'orch factory' });
  const selectedTab = () => screen.getByRole('tab', { selected: true });
  const board = () => screen.findByRole('table', { name: 'Factory jobs' });
  const query = () => new URLSearchParams(window.location.hash.slice(3));

  it('a fresh load of a board URL restores Show, Repository, Filter, and sort (AC1)', async () => {
    window.location.hash = '#/?show=needs-human&repo=gamma&q=Gamma&sort=updated:desc';
    mockFetch();
    mount();
    await screen.findByText('Gamma blocked');
    expect(select('Show')).toHaveValue('needs human');
    await waitFor(() => {
      expect(select('Repository')).toHaveValue('gamma');
    });
    expect(filter()).toHaveValue('Gamma');
    expect(th('Updated')).toHaveAttribute('aria-sort', 'descending');
    expect(jobsNav()).toHaveAttribute(
      'href',
      '#/?show=needs-human&repo=gamma&q=Gamma&sort=updated%3Adesc',
    );
  });

  it('a fresh load of a bare #/ shows the defaults (AC1)', async () => {
    window.location.hash = '#/';
    mockFetch();
    mount();
    await board();
    expect(select('Show')).toHaveValue('current');
    expect(select('Repository')).toHaveValue('');
    expect(filter()).toHaveValue('');
    expect(sorted()).toHaveLength(0);
    expect(window.location.hash).toBe('#/');
  });

  it('board changes replace the URL without history or hashchange, and clearing gives #/ (AC2)', async () => {
    mockFetch();
    mount();
    await board();
    const length = window.history.length;
    const changes = vi.fn();
    window.addEventListener('hashchange', changes);
    await choose('Show', /^failed/);
    expect(window.location.hash).toBe('#/?show=failed');
    await choose('Repository', 'gamma');
    expect(window.location.hash).toBe('#/?show=failed&repo=gamma');
    fireEvent.click(screen.getByRole('button', { name: /need human$/ }));
    expect(window.location.hash).toBe('#/?show=needs-human&repo=gamma');
    expect(jobsNav()).toHaveAttribute('href', '#/?show=needs-human&repo=gamma');
    expect(brand()).toHaveAttribute('href', '#/?show=needs-human&repo=gamma');
    // Clearing every setting writes exactly #/.
    fireEvent.click(screen.getByRole('button', { name: /need human$/ }));
    await choose('Repository', 'All repositories');
    expect(window.location.hash).toBe('#/');
    expect(jobsNav()).toHaveAttribute('href', '#/');
    expect(window.history.length).toBe(length);
    expect(changes).not.toHaveBeenCalled();
    window.removeEventListener('hashchange', changes);
    // A reload shows the defaults.
    cleanup();
    mount();
    await board();
    expect(select('Show')).toHaveValue('current');
    expect(select('Repository')).toHaveValue('');
  });

  it('a column sort is written to the URL (AC2)', async () => {
    mockFetch();
    mount();
    await board();
    const length = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    expect(query().get('sort')).toBe('updated:asc');
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    expect(query().get('sort')).toBe('updated:desc');
    expect(window.history.length).toBe(length);
  });

  it('a summary chip on a job route leaves the job URL alone; #/ then shows it (AC2)', async () => {
    window.location.hash = '#/jobs/job-00000003/events';
    mockFetch();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    fireEvent.click(await screen.findByRole('button', { name: /need human$/ }));
    expect(window.location.hash).toBe('#/jobs/job-00000003/events');
    go('#/');
    await board();
    expect(select('Show')).toHaveValue('needs human');
    expect(window.location.hash).toBe('#/?show=needs-human');
  });

  it('Filter writes the URL once after typing stops, or at once on blur (AC3)', async () => {
    mockFetch();
    mount();
    await board();
    vi.useFakeTimers();
    try {
      for (const v of ['a', 'al', 'alp']) {
        fireEvent.change(filter(), { target: { value: v } });
        vi.advanceTimersByTime(300);
        expect(window.location.hash).toBe('');
      }
      vi.advanceTimersByTime(99);
      expect(window.location.hash).toBe('');
      vi.advanceTimersByTime(1);
      expect(window.location.hash).toBe('#/?q=alp');
      fireEvent.change(filter(), { target: { value: 'alph' } });
      fireEvent.blur(filter());
      expect(window.location.hash).toBe('#/?q=alph');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opening a row flushes the pending Filter write first, and nothing rewrites the job URL (AC3)', async () => {
    mockFetch();
    mount();
    await board();
    const replace = vi.spyOn(window.history, 'replaceState');
    vi.useFakeTimers();
    try {
      fireEvent.change(filter(), { target: { value: 'Gamma' } });
      fireEvent.click(within(boardRowOf('job-00000003')).getByText('30m'));
      expect(replace.mock.calls.map((c) => c[2])).toContain('#/?q=Gamma');
      expect(window.location.hash).toBe('#/jobs/job-00000003');
      vi.advanceTimersByTime(1000);
      expect(window.location.hash).toBe('#/jobs/job-00000003');
    } finally {
      vi.useRealTimers();
    }
    replace.mockClear();
    // Enter on a row flushes the same way.
    go('#/');
    await board();
    fireEvent.change(filter(), { target: { value: 'Delta' } });
    const r = boardRowOf('job-00000004');
    r.focus();
    fireEvent.keyDown(r, { key: 'Enter' });
    expect(replace.mock.calls.map((c) => c[2])).toContain('#/?q=Delta');
    expect(window.location.hash).toBe('#/jobs/job-00000004');
    replace.mockRestore();
  });

  it('a pending Filter write is dropped when the route changes another way (AC3)', async () => {
    mockFetch();
    mount();
    await board();
    vi.useFakeTimers();
    try {
      fireEvent.change(filter(), { target: { value: 'zzz' } });
      go('#/jobs/job-00000003');
      vi.advanceTimersByTime(1000);
      expect(window.location.hash).toBe('#/jobs/job-00000003');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a bare #/ keeps Show, Repository, Filter, and sort and replaces the URL with them (AC4)', async () => {
    mockFetch();
    mount();
    await board();
    await choose('Repository', 'gamma');
    fireEvent.change(filter(), { target: { value: 'delta' } });
    fireEvent.blur(filter());
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    const url = window.location.hash;
    expect(url).toBe('#/?repo=gamma&q=delta&sort=updated%3Aasc');
    go('#/jobs/job-00000003');
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(jobsNav()).toHaveAttribute('href', url);
    expect(brand()).toHaveAttribute('href', url);
    go('#/');
    await board();
    expect(window.location.hash).toBe(url);
    expect(select('Repository')).toHaveValue('gamma');
    expect(filter()).toHaveValue('delta');
    expect(th('Updated')).toHaveAttribute('aria-sort', 'ascending');
    // An address-bar edit to #/ while on the board keeps them too.
    go('#/');
    expect(window.location.hash).toBe(url);
    expect(filter()).toHaveValue('delta');
  });

  it('a hashchange to a board URL with parameters sets exactly those (AC5)', async () => {
    mockFetch();
    mount();
    await board();
    await choose('Show', /^cancelled/);
    fireEvent.change(filter(), { target: { value: 'delta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Updated' }));
    go('#/?show=failed');
    await waitFor(() => {
      expect(select('Show')).toHaveValue('failed');
    });
    expect(filter()).toHaveValue('');
    expect(select('Repository')).toHaveValue('');
    expect(sorted()).toHaveLength(0);
  });

  it.each(['#/?show=bogus', '#/?sort=nope:asc', '#/?sort=updated:up', '#/?sort=updated'])(
    'invalid board input %s gives the defaults (AC9)',
    async (hash) => {
      window.location.hash = hash;
      mockFetch();
      mount();
      await board();
      expect(select('Show')).toHaveValue('current');
      expect(sorted()).toHaveLength(0);
    },
  );

  it('a repo missing from the loaded list gives All repositories (AC9)', async () => {
    window.location.hash = '#/?repo=github.com%2Fnobody%2Fnothing&show=failed';
    mockFetch();
    mount();
    await waitFor(() => {
      expect(window.location.hash).toBe('#/?show=failed');
    });
    expect(select('Repository')).toHaveValue('');
    expect(select('Show')).toHaveValue('failed');
  });

  it('a tab URL opens that tab; an unavailable or unknown tab renders Overview (AC6, AC9, AC10)', async () => {
    window.location.hash = '#/jobs/job-00000003';
    mockFetch();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(selectedTab()).toHaveAttribute('id', 'tab-Overview');
    const d = detail();
    // Some tab is unavailable for this detail, so the fallback is exercised.
    expect(TABS.some((t) => t !== 'Overview' && resolveTab(d, t) === 'Overview')).toBe(true);
    for (const t of TABS) {
      go(`#/jobs/job-00000003/${t.toLowerCase()}`);
      await waitFor(() => {
        expect(selectedTab()).toHaveAttribute('id', `tab-${resolveTab(d, t)}`);
      });
    }
    go('#/jobs/job-00000003/events');
    await waitFor(() => {
      expect(selectedTab()).toHaveAttribute('id', 'tab-Events');
    });
    go('#/jobs/job-00000003/bogus');
    await waitFor(() => {
      expect(selectedTab()).toHaveAttribute('id', 'tab-Overview');
    });
  });

  it('a tab click pushes its URL, Overview the bare job URL, and Back returns (AC6, AC10)', async () => {
    window.location.hash = '#/jobs/job-00000003';
    mockFetch();
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    const length = window.history.length;
    fireEvent.click(screen.getByRole('tab', { name: /^Events/ }));
    expect(window.location.hash).toBe('#/jobs/job-00000003/events');
    expect(window.history.length).toBe(length + 1);
    expect(selectedTab()).toHaveAttribute('id', 'tab-Events');
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(window.location.hash).toBe('#/jobs/job-00000003');
    fireEvent.click(screen.getByRole('tab', { name: /^Findings/ }));
    expect(window.location.hash).toBe('#/jobs/job-00000003/findings');
    window.history.back();
    await waitFor(() => {
      expect(window.location.hash).toBe('#/jobs/job-00000003');
    });
    await waitFor(() => {
      expect(selectedTab()).toHaveAttribute('id', 'tab-Overview');
    });
  });

  describe('review round and reviewer links (AC7)', () => {
    const review = {
      jobId: 'job-00000003',
      artifactId: 1,
      head: 'abc',
      model: null,
      sameAsAuthor: null,
      summary: null,
      verdict: 'pass' as const,
      createdAt: '2026-11-13T08:10:00.000Z',
      completedAt: '2026-11-13T08:20:00.000Z',
    };
    const scroll = vi.fn();
    beforeEach(() => {
      scroll.mockClear();
      // jsdom has no scrollIntoView of its own.
      Element.prototype.scrollIntoView = scroll;
      data.detail = detail({
        contents: {
          'round-1/security.md': 'Security body text',
          'round-1/odd.md': 'Odd body text',
          'round-2/correctness.md': 'Correctness body text',
        },
        rounds: [
          {
            round: 1,
            reviews: [
              { ...review, round: 1, id: 1, reviewer: 'security', path: 'round-1/security.md' },
              { ...review, round: 1, id: 2, reviewer: 'a b/c%', path: 'round-1/odd.md' },
            ],
            consolidated: null,
            blocking: null,
          },
          {
            round: 2,
            reviews: [
              {
                ...review,
                round: 2,
                id: 3,
                reviewer: 'correctness',
                path: 'round-2/correctness.md',
              },
            ],
            consolidated: null,
            blocking: null,
          },
        ],
      });
    });
    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });
    const header = (name: RegExp) => screen.getByRole('button', { name });

    it('a round link opens Reviews and scrolls to it; a reviewer link also expands it', async () => {
      window.location.hash = '#/jobs/job-00000003/reviews/2';
      mockFetch();
      mount();
      await screen.findByRole('heading', { name: 'Gamma blocked' });
      expect(selectedTab()).toHaveAttribute('id', 'tab-Reviews');
      await waitFor(() => {
        expect(scroll).toHaveBeenCalled();
      });
      expect(scroll.mock.contexts[0]).toHaveAttribute('id', 'review-round-2');
      expect(header(/^correctness/)).toHaveAttribute('aria-expanded', 'false');
      go(`#/jobs/job-00000003/reviews/1/${encodeURIComponent('a b/c%')}`);
      await waitFor(() => {
        expect(header(/^a b\/c%/)).toHaveAttribute('aria-expanded', 'true');
      });
      expect(header(/^security/)).toHaveAttribute('aria-expanded', 'false');
      expect(scroll.mock.contexts.at(-1)).toHaveAttribute('id', 'review-round-1');
    });

    it('a collapsed linked report stays collapsed across polls; a hand expansion replaces the URL', async () => {
      window.location.hash = '#/jobs/job-00000003/reviews/1/security';
      mockFetch();
      mount();
      await screen.findByRole('heading', { name: 'Gamma blocked' });
      await waitFor(() => {
        expect(header(/^security/)).toHaveAttribute('aria-expanded', 'true');
      });
      expect(await screen.findByText('Security body text')).toBeInTheDocument();
      fireEvent.click(header(/^security/));
      expect(header(/^security/)).toHaveAttribute('aria-expanded', 'false');
      // mount() polls every 50 ms; several polls later it is still collapsed.
      await new Promise((r) => setTimeout(r, 300));
      expect(header(/^security/)).toHaveAttribute('aria-expanded', 'false');
      const length = window.history.length;
      fireEvent.click(header(/^correctness/));
      expect(window.location.hash).toBe('#/jobs/job-00000003/reviews/2/correctness');
      expect(window.history.length).toBe(length);
    });

    it('an unknown round or reviewer opens Reviews with nothing expanded (AC9)', async () => {
      for (const hash of [
        '#/jobs/job-00000003/reviews/9',
        '#/jobs/job-00000003/reviews/1/nobody',
        '#/jobs/job-00000003/reviews/x/security',
        '#/jobs/job-00000003/reviews/1/%E0%A4%A',
      ]) {
        window.location.hash = hash;
        mockFetch();
        mount();
        await screen.findByRole('heading', { name: 'Gamma blocked' });
        expect(selectedTab()).toHaveAttribute('id', 'tab-Reviews');
        for (const name of [/^security/, /^a b/, /^correctness/]) {
          expect(header(name)).toHaveAttribute('aria-expanded', 'false');
        }
        cleanup();
      }
    });
  });

  it("the board's Reviews rollup chip links to the job's current round (AC8)", async () => {
    mockFetch();
    mount();
    await board();
    const chip = must(within(boardRowOf('job-00000002')).getByText('1/2, 1 pending').closest('a'));
    expect(chip).toHaveAttribute('href', '#/jobs/job-00000002/reviews/1');
  });
});
