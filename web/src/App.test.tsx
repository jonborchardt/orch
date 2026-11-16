// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { ThemeProvider } from '@mui/material';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardRow, CiView, JobDetailView } from '../../src/server/types.ts';
import { App } from './App.tsx';
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
    updatedAt: '2026-11-13T08:30:00.000Z',
    elapsedMs: 1_800_000,
    pr: { url: null, state: null, phase: 'no-pr' },
    supersededBy: null,
    supersedes: [],
    archivedAt: null,
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
  }),
  row({
    id: 'job-00000004',
    title: 'Delta cancelled',
    repo: 'gamma',
    stage: 'build',
    status: 'cancelled',
    liveness: 'cancelled',
    owner: null,
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
    prPhase: 'no-pr',
    actions: ['approve', 'request-review', 'request-rework', 'cancel'],
    links: { vscode: 'vscode://file//wt/g', checkout: 'vscode://file//g', pr: null },
    session: null,
    resume: { command: '/factory resume job-00000003', heldBy: null },
    resumeCommand: 'orch factory resume job-00000003 --session <name>',
    supersedes: [],
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
      guidance:
        'Add CI and Approve back to ci, or accept the delivery by hand (recorded as a human close-out).',
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
    expect(screen.getByTestId('ci-guidance')).toHaveTextContent('repair budget is spent');
    fireEvent.click(screen.getByRole('tab', { name: 'PR' }));
    expect(screen.getByTestId('ci-panel')).toHaveTextContent('Repairs used: 1 of 1');
    expect(screen.getByTestId('ci-panel')).toHaveTextContent('CI failing @d4e5f60');
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
    fireEvent.click(await screen.findByRole('option', { name: filter }));
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
    fireEvent.click(await screen.findByRole('option', { name: filter }));
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
      'Blocking column',
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

  it('sorts by a header click, ascending then descending, and keeps server order until then', async () => {
    mockFetch();
    mount();
    await screen.findByRole('table', { name: 'Factory jobs' });
    expect(ids()).toEqual(['job-00000001', 'job-00000002', 'job-00000003', 'job-00000004']);
    const header = (name: string) =>
      must(screen.getByRole('button', { name }).closest<HTMLElement>('th'));
    fireEvent.click(screen.getByRole('button', { name: 'Blocking' }));
    expect(header('Blocking')).toHaveAttribute('aria-sort', 'ascending');
    expect(ids().at(-1)).toBe('job-00000002');
    fireEvent.click(screen.getByRole('button', { name: 'Blocking' }));
    expect(header('Blocking')).toHaveAttribute('aria-sort', 'descending');
    expect(ids()[0]).toBe('job-00000002');
    fireEvent.click(screen.getByRole('button', { name: 'Job' }));
    expect(header('Job')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Blocking')).not.toHaveAttribute('aria-sort');
    expect(ids()).toEqual(['job-00000001', 'job-00000002', 'job-00000004', 'job-00000003']);
    fireEvent.click(screen.getByRole('button', { name: 'Job' }));
    expect(ids()).toEqual(['job-00000003', 'job-00000004', 'job-00000002', 'job-00000001']);
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
    await show('all');
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

  it('Show: archived lists Unarchive on each row; after it the row returns to all', async () => {
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
    await show('all');
    await waitFor(() => {
      expect(ids()).toContain('job-00000009');
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
