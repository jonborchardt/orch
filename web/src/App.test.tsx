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

import type { BoardRow, CiView, JobDetailView, Progress } from '../../src/server/types.ts';
import { App } from './App.tsx';
import { CiChip } from './Ci.tsx';
import { byAttention, ciColor, repoLabels, reviewRollup } from './format.ts';
import { Markdown } from './Markdown.tsx';
import { RESUME_NOTE } from './Status.tsx';
import { theme } from './main.tsx';

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
    liveness: 'running',
    round: 0,
    maxRounds: 3,
    owner: { session: 'claude-1', leaseExpiresAt: '2999-01-01T00:00:00.000Z', live: true },
    worktreePath: '/wt',
    branch: 'factory/job-00000001-job',
    reviews: [],
    blocking: null,
    blocker: null,
    resume: null,
    updatedAt: '2026-11-13T08:30:00.000Z',
    elapsedMs: 1_800_000,
    pr: { url: null, state: null, phase: 'no-pr' },
    supersededBy: null,
    supersedes: [],
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
    pr: { url: 'https://github.com/x/y/pull/1', state: 'draft', phase: 'ci-failing' },
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
      revision: 9,
      createdAt: '2026-11-13T08:00:00.000Z',
      updatedAt: '2026-11-13T08:30:00.000Z',
      completedAt: null,
      policy: null,
      policyHead: null,
      supersededBy: null,
      archivedAt: null,
      mailCursor: null,
      mailThreadId: null,
      mailSubject: null,
      mailLastId: null,
    },
    liveness: 'blocked',
    artifacts: [],
    contents: {
      'round-1/consolidated.md': `# C\n\n## Findings\n\n${longFindings}\n\nBLOCKING: 0\n`,
    },
    rounds: [{ round: 1, reviews: [], consolidated: 'round-1/consolidated.md', blocking: 0 }],
    events: [],
    plan: null,
    planError: 'config broken',
    blocker: {
      kind: 'decision',
      summary: 'Approver escalated: a human must decide',
      detail: 'AC2 needs deployment verification',
    },
    ci: noCi(),
    progress: progress(4, 'stopped', 'Approve, needs human'),
    timeline: { entries: [], truncated: false },
    prPhase: 'no-pr',
    actions: ['approve', 'request-review', 'request-rework', 'cancel'],
    links: { vscode: 'vscode://file//wt/g', checkout: 'vscode://file//g', pr: null },
    session: null,
    resume: { command: '/factory resume job-00000003', heldBy: null },
    resumeCommand: 'orch factory resume job-00000003 --session <name>',
    supersedes: [],
    flake: null,
    ...over,
  };
}

type FetchMock = ReturnType<typeof vi.fn>;

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
let data: { rows: BoardRow[]; detail: JobDetailView; actionStatus: number; actionBody: unknown };
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
    if (url === '/api/repos') return json(200, [...new Set(data.rows.map((r) => r.repo))]);
    if (url === '/api/session')
      return json(200, { csrf: 'tok', version: '0', database: 'db', actions: [] });
    if (/^\/api\/jobs\/job-[0-9a-f]{8}\/actions$/.test(url) && init?.method === 'POST') {
      return json(data.actionStatus, data.actionBody);
    }
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
    actionStatus: 200,
    actionBody: {
      job: detail().job,
      message: 'Recorded: job returned to approve (pending). No session is running it; resume it',
      resumeCommand: 'orch factory resume job-00000003 --session <name>',
      supersedes: [],
    },
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
      timeline: {
        truncated: true,
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
    // Times read as elsewhere on the dashboard ("… ago"); the exact timestamp stays in the markup.
    const build = within(steps).getAllByRole('listitem')[1];
    expect(build).toHaveTextContent(/started .* ago/);
    expect(build?.querySelector('time')).toHaveAttribute('datetime', at(5));
    expect(build?.querySelector('time')).toHaveAttribute('title', at(5));
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
    expect(within(section).getByText(/Earlier history not shown/)).toBeInTheDocument();
  });

  it('filters cancelled jobs separately from finished ones', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Show' }));
    fireEvent.click(await screen.findByRole('option', { name: 'cancelled (1)' }));
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
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Show' }));
    fireEvent.click(await screen.findByRole('option', { name: 'cancelled (1)' }));
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
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveTextContent('cancelled (1)');
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

describe('Job detail', () => {
  it('renders long findings, the plan error, and a working Resume at <stage> action', async () => {
    const f = mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText(/Plan unavailable: config broken/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Findings' }));
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
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Show' }));
    fireEvent.click(
      await screen.findByRole('option', { name: new RegExp(`^${filter} [(][0-9]+[)]$`) }),
    );
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
        expect(screen.getByRole('combobox', { name: 'Show' })).toHaveTextContent(f);
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
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Show' }));
    fireEvent.click(
      await screen.findByRole('option', { name: new RegExp(`^${filter} [(][0-9]+[)]$`) }),
    );
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
    for (const name of ['Stage', 'Status', 'Round', 'Elapsed', 'Updated']) {
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
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Repository' }));
    fireEvent.click(await screen.findByRole('option', { name: 'gamma' }));
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
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Repository' }));
    fireEvent.click(await screen.findByRole('option', { name: 'gamma' }));
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
    const pr = within(boardRow('job-00000003')).getByRole('link', { name: 'PR (draft)' });
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
      createdAt: '2026-11-13T08:10:00.000Z',
      completedAt: '2026-11-13T08:20:00.000Z',
    };
    data.detail = detail({
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
    fireEvent.click(screen.getByRole('tab', { name: 'Reviews' }));
    expect(screen.getByText('blocking 1')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('tab', { name: 'Reviews' }));
    expect(screen.getByRole('heading', { name: /^Round 2 \(current\)/ })).toBeInTheDocument();
    const old = screen.getByRole('heading', { name: /^Round 1/ });
    expect(old).not.toHaveTextContent('current');
    // History: round 1's CHANGES is still listed beside round 2's PASS.
    expect(screen.getByRole('button', { name: /correctness.*changes/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /correctness.*pass/ })).toBeInTheDocument();
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
        pr: { ...failing.pr, state: 'ready', phase: 'ready-to-merge' },
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
    expect(show).toHaveTextContent('current (7)');

    fireEvent.click(chip('1 need human'));
    await waitFor(() => {
      expect(ids()).toEqual(['job-00000003']);
    });
    expect(chip('1 need human')).toHaveAttribute('aria-pressed', 'true');
    expect(ringed()).toEqual(['1 need human']);
    // An explicit text-colour ring, not currentColor (white on a filled chip).
    expect(getComputedStyle(chip('1 need human')).outlineColor).toBe(theme.palette.text.primary);
    expect(getComputedStyle(chip('1 need human')).outlineWidth).toBe('2px');
    expect(show).toHaveTextContent('needs human (1)');
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
    expect(show).toHaveTextContent('current (7)');
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

    fireEvent.mouseDown(show);
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox)
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
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveTextContent(/^current$/);
    hold = {};
    gate.resolve(undefined);
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(screen.queryByRole('progressbar', { name: 'Loading jobs' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveTextContent('current (4)');
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
