// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { ThemeProvider } from '@mui/material';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardRow, CiView, JobDetailView } from '../../src/server/types.ts';
import { App } from './App.tsx';
import { ciSummary } from './Ci.tsx';
import { Markdown } from './Markdown.tsx';
import { theme } from './main.tsx';

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
    createdAt: '2026-11-13T08:00:00.000Z',
    updatedAt: '2026-11-13T08:30:00.000Z',
    completedAt: null,
    elapsedMs: 1_800_000,
    pr: { url: null, state: null, ciStatus: null, ciCheckedAt: null },
    ci: noCi(),
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
      ciStatus: 'failing',
      ciCheckedAt: null,
    },
    ci: noCi({ status: 'failing', head: 'abcdef0123456789', outcome: 'failing', repairs: 1 }),
  }),
  row({
    id: 'job-00000004',
    title: 'Delta cancelled',
    repo: 'gamma',
    stage: 'build',
    status: 'cancelled',
    liveness: 'cancelled',
    owner: null,
    completedAt: '2026-11-13T08:40:00.000Z',
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
    },
    liveness: 'blocked',
    artifacts: [],
    contents: {
      'round-1/consolidated.md': `# C\n\n## Findings\n\n${longFindings}\n\nBLOCKING: 0\n`,
    },
    rounds: [{ round: 1, reviews: [], consolidated: 'round-1/consolidated.md', blocking: 0 }],
    events: [],
    worktree: null,
    plan: null,
    planError: 'config broken',
    blocker: {
      kind: 'decision',
      summary: 'Approver escalated: a human must decide',
      detail: 'AC2 needs deployment verification',
    },
    ci: noCi(),
    actions: ['approve', 'request-review', 'request-rework', 'cancel'],
    links: { vscode: 'vscode://file//wt/g', checkout: 'vscode://file//g', pr: null },
    session: null,
    resume: { command: '/factory resume job-00000003', heldBy: null },
    resumeCommand: 'orch factory resume job-00000003 --session <name>',
    ...over,
  };
}

type FetchMock = ReturnType<typeof vi.fn>;

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('expected an element');
  return x;
}
let data: { rows: BoardRow[]; detail: JobDetailView; actionStatus: number; actionBody: unknown };

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
    if (url.startsWith('/api/jobs?') || url === '/api/jobs') return json(200, data.rows);
    if (url === '/api/repos') return json(200, [...new Set(data.rows.map((r) => r.repo))]);
    if (url === '/api/session')
      return json(200, { csrf: 'tok', version: '0', database: 'db', actions: [] });
    if (/^\/api\/jobs\/job-[0-9a-f]{8}\/actions$/.test(url) && init?.method === 'POST') {
      return json(data.actionStatus, data.actionBody);
    }
    if (/^\/api\/jobs\/job-[0-9a-f]{8}$/.test(url)) return json(200, data.detail);
    return json(404, { error: { type: 'NotFoundError', message: `no ${url}` } });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

function mount() {
  return render(
    <ThemeProvider theme={theme} defaultMode="light">
      <App refreshMs={50} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
  data = {
    rows,
    detail: detail(),
    actionStatus: 200,
    actionBody: {
      job: detail().job,
      message: 'Recorded: job returned to approve (pending). No session is running it; resume it',
      resumeCommand: 'orch factory resume job-00000003 --session <name>',
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

  it('renders every repository and distinguishes running from last-reported-running', async () => {
    mockFetch();
    mount();
    const table = await screen.findByRole('table', { name: 'Factory jobs' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByText(/running \(lease live\)/)).toBeInTheDocument();
    expect(within(table).getByText(/last reported running/)).toBeInTheDocument();
    expect(within(table).getByText(/needs human/)).toBeInTheDocument();
    expect(within(table).getByText('correctness: pending')).toBeInTheDocument();
    expect(within(table).getByText('CI failing @abcdef0')).toBeInTheDocument();
    expect(within(table).getByText('repairs 1/2')).toBeInTheDocument();
    expect(within(table).getByText('github.com/acme/beta')).toBeInTheDocument();
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
    // The workflow stage it stopped in is still shown, as a stage, next to the cancelled status.
    expect(within(cancelled).getByText('build')).toBeInTheDocument();
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
      'Copy resume command for job-00000002',
      'Copy resume command for job-00000003',
    ]);
    fireEvent.click(must(copies[1]));
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

  it('filters cancelled jobs separately from finished ones', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Show' }));
    fireEvent.click(await screen.findByRole('option', { name: 'cancelled' }));
    await waitFor(() => {
      expect(screen.getAllByRole('row')).toHaveLength(2);
    });
    expect(screen.getByText('Delta cancelled')).toBeInTheDocument();
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

  it('shows API errors without crashing and toggles dark mode', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Switch to dark mode/ }));
    await waitFor(() => {
      expect(window.localStorage.getItem('mui-mode')).toBe('dark');
    });
    expect(screen.getByRole('button', { name: /Switch to light mode/ })).toBeInTheDocument();
  });
});

describe('Job detail', () => {
  it('renders long findings, the plan error, and a working approve action', async () => {
    mockFetch();
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

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/does not start or wake any Claude session/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No session is running it');
    });
    expect(
      within(screen.getByRole('status')).getByText(
        'orch factory resume job-00000003 --session <name>',
      ),
    ).toBeInTheDocument();
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

  it('makes Approve primary only at a genuine approval gate, with the resume affordance', async () => {
    mockFetch();
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText('Decision needed.')).toBeInTheDocument();
    expect(screen.getByText(/Recorded reason: AC2 needs deployment verification/)).toBeVisible();
    const approve = screen.getByRole('button', { name: 'Approve' }).className;
    expect(approve).toContain('MuiButton-contained');
    expect(approve).toContain('MuiButton-colorSuccess');
    expect(screen.queryByTestId('approve-caution')).not.toBeInTheDocument();
    const resume = screen.getByTestId('resume');
    expect(within(resume).getByText('/factory resume job-00000003')).toBeInTheDocument();
    expect(within(resume).getByText(/opened in/).textContent).toContain('/g');
    expect(within(resume).getByText(/Copying does not resume anything/)).toBeInTheDocument();
    expect(within(resume).getByRole('link', { name: 'Open checkout in VS Code' })).toHaveAttribute(
      'href',
      'vscode://file//g',
    );
    expect(screen.getByText(/stage: needs-human/)).toBeInTheDocument();
  });

  it('demotes Approve and admits an unknown reason when the escalation is not a decision', async () => {
    mockFetch();
    data.detail = detail({
      blocker: { kind: 'escalated', summary: 'Escalated from build', detail: null },
    });
    window.location.hash = '#/jobs/job-00000003';
    mount();
    await screen.findByRole('heading', { name: 'Gamma blocked' });
    expect(screen.getByText(/No reason was recorded/)).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve.className).toContain('MuiButton-outlined');
    expect(approve.className).not.toContain('MuiButton-colorSuccess');
    expect(screen.getByTestId('approve-caution')).toHaveTextContent('not waiting for an approval');
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
    expect(screen.getByRole('button', { name: 'Request rework' }).className).toContain(
      'MuiButton-contained',
    );
    expect(screen.getByRole('button', { name: 'Approve' }).className).toContain(
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
    expect(screen.queryByTestId('resume')).not.toBeInTheDocument();
    const unavailable = screen.getByTestId('resume-unavailable');
    expect(unavailable).toHaveTextContent('claude-9');
    expect(unavailable).toHaveTextContent('never forces ownership');
    expect(screen.queryByRole('button', { name: /Copy resume command/ })).not.toBeInTheDocument();
    // The decision gate itself is unaffected by who holds the lease.
    expect(screen.getByRole('button', { name: 'Approve' }).className).toContain(
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
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    // An interruption is not a rework decision: every remaining control stays neutral.
    expect(screen.getByRole('button', { name: 'Request rework' }).className).toContain(
      'MuiButton-outlined',
    );
    expect(screen.getByText('Interrupted.')).toBeInTheDocument();
    expect(screen.getByTestId('resume')).toHaveTextContent('/factory resume job-00000003');
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
    expect(screen.getByText(/Recorded reason: dup/)).toBeInTheDocument();
  });

  it('offers Accept delivery only when the server lists it, requires a reason, and labels the result', async () => {
    const f = mockFetch();
    const base = detail();
    const ciNone = noCi({
      head: 'b2c3d4e5f6071829',
      status: 'none',
      outcome: 'none',
      checkedAt: base.job.updatedAt,
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
    expect(screen.getByTestId('ci-guidance')).toHaveTextContent('accept the delivery by hand');
    expect(screen.getByTestId('close-out-caution')).toHaveTextContent('CI is none for b2c3d4e');
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
    expect(screen.getByTestId('ci-guidance')).toHaveTextContent('repair budget is spent');
    fireEvent.click(screen.getByRole('tab', { name: 'PR' }));
    expect(screen.getByTestId('ci-panel')).toHaveTextContent('Repairs used: 1 of 1');
    expect(screen.getByTestId('ci-panel')).toHaveTextContent('CI failing @d4e5f60');
  });

  it('describes every CI state from structured fields, never from a stale verdict', () => {
    const base = detail();
    const withPr = (over: Partial<typeof base.job>) => ({
      ...base.job,
      prUrl: 'https://github.com/x/y/pull/9',
      prState: 'draft' as const,
      stage: 'ci' as const,
      status: 'running' as const,
      ...over,
    });
    const line = (job: typeof base.job, ci: Partial<CiView>) =>
      ciSummary({ job, ci: noCi(ci) }).line;
    expect(line(base.job, {})).toBe('No PR yet.');
    expect(line(withPr({}), {})).toBe('PR created; CI not yet observed.');
    expect(line(withPr({}), { head: 'a1b2c3d4', status: 'pending', current: true })).toBe(
      'CI pending for a1b2c3d.',
    );
    expect(line(withPr({}), { head: 'a1b2c3d4', status: 'passing', current: true })).toBe(
      'CI passing for a1b2c3d.',
    );
    // A green verdict for a commit that is no longer HEAD is said to be stale, in so many words.
    expect(line(withPr({}), { head: 'a1b2c3d4', status: 'passing', current: false })).toContain(
      'not the current HEAD',
    );
    expect(
      line(withPr({ stage: 'build', status: 'pending' }), {
        head: 'a1b2c3d4',
        status: 'failing',
        repairs: 1,
      }),
    ).toBe('CI failed for a1b2c3d; repair in progress (1 of 2 repairs used, stage build).');
    expect(
      line(withPr({ stage: 'needs-human', status: 'blocked' }), {
        head: 'a1b2c3d4',
        status: 'failing',
        repairs: 2,
      }),
    ).toBe('CI still failing for a1b2c3d; 2 of 2 repairs used.');
    expect(
      line(withPr({ stage: 'needs-human', status: 'blocked' }), {
        head: 'a1b2c3d4',
        status: 'none',
      }),
    ).toBe('GitHub reports no checks for a1b2c3d.');
    expect(
      line(withPr({ stage: 'needs-human', status: 'blocked' }), {
        head: 'a1b2c3d4',
        status: 'failing',
        outcome: 'infrastructure',
      }),
    ).toContain('did not reach a verdict');
    expect(
      line(withPr({ stage: 'needs-human', status: 'blocked' }), {
        head: 'a1b2c3d4',
        status: 'pending',
        outcome: 'closed',
      }),
    ).toContain('closed without merging');
    expect(
      line(withPr({ stage: 'needs-human', status: 'blocked' }), {
        head: 'a1b2c3d4',
        status: 'passing',
        outcome: 'outdated',
      }),
    ).toContain('moved outside the job');
    expect(
      line(withPr({ stage: 'needs-human', status: 'blocked', prState: 'merged' }), {
        head: 'a1b2c3d4',
        status: 'failing',
      }),
    ).toContain('merged outside the factory');
    const finished = withPr({ stage: 'completed', status: 'completed' });
    expect(line(finished, { head: 'a1b2c3d4', status: 'passing', completion: 'ci' })).toBe(
      'Completed: required checks passed for a1b2c3d.',
    );
    expect(line(finished, { head: 'a1b2c3d4', status: 'none', completion: 'human' })).toBe(
      'Completed by human close-out; CI was none for a1b2c3d.',
    );
    expect(line(finished, { completion: 'legacy' })).toContain('before the ci stage existed');
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

describe('Job detail: execution session', () => {
  const link = 'agent-host-session://ahp-session/17b6e18f-4046-422b-8336-cb43a130967f';
  const uuid = '565e2b23-152d-4533-b6b3-e1d4981c7297';

  it('says so when no session was recorded', async () => {
    window.location.hash = '#/jobs/job-00000003';
    mockFetch();
    mount();
    await waitFor(() => {
      expect(screen.getByTestId('session-none')).toHaveTextContent('No execution session');
    });
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
    await waitFor(() => {
      expect(screen.getByTestId('session')).toBeInTheDocument();
    });
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
    await waitFor(() => {
      expect(screen.getByTestId('session')).toBeInTheDocument();
    });
    const s = screen.getByTestId('session');
    expect(within(s).getByRole('link', { name: 'Open session in VS Code' })).toHaveAttribute(
      'href',
      `vscode://anthropic.claude-code/open?session=${uuid}`,
    );
    expect(s).toHaveTextContent(`claude --resume ${uuid}`);
    expect(s).not.toHaveTextContent('earlier attachment');
  });
});
