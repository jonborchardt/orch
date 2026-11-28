// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { ThemeProvider } from '@mui/material';
import { cleanup, configure, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentsView,
  BuilderModelRow,
  ReviewerModelRow,
  ReviewerRow,
  RunsView,
  StageRow,
} from '../../src/server/types.ts';
import { App } from './App.tsx';
import { theme } from './theme.ts';

configure({ asyncUtilTimeout: 10_000 });

const RUNS: RunsView = {
  total: 5,
  completed: 3,
  cancelled: 1,
  active: 1,
  completionRate: 0.75,
  durationMs: { average: 2 * 3_600_000, median: null },
  durationUnknown: 1,
  completedPerHour: null,
  trust: {
    full: {
      finishedJobs: 4,
      escalationRate: 0.25,
      firstPassRate: 0.5,
      rounds: { median: 1.5, max: 2 },
      ciRepairs: { median: 0, max: 1 },
      elapsedMs: 3_600_000,
      agentSeconds: 90,
      tokens: 330,
    },
    fast: {
      finishedJobs: 0,
      escalationRate: null,
      firstPassRate: null,
      rounds: { median: null, max: null },
      ciRepairs: { median: null, max: null },
      elapsedMs: null,
      agentSeconds: null,
      tokens: null,
    },
  },
  tickets: [
    {
      ticketKey: '0007',
      title: 'Export CSV',
      jobId: 'job-0000abcd',
      mode: 'full',
      jobCount: 2,
      rounds: 2,
      ciRepairs: 1,
      escalated: true,
      elapsedMs: 2 * 3_600_000,
      agentSeconds: 180,
      tokens: { input: 300, output: 30, cacheRead: 0, cacheCreation: 0 },
      tokenJobs: 2,
    },
    {
      ticketKey: '0008',
      title: 'Plain',
      jobId: 'job-0000abce',
      mode: 'full',
      jobCount: 1,
      rounds: 1,
      ciRepairs: 0,
      escalated: false,
      elapsedMs: null,
      agentSeconds: null,
      tokens: null,
      tokenJobs: 0,
    },
  ],
};

const timed = { unmeasured: 0, averageMs: null, medianMs: null, totalMs: null, tokens: null };
const stage = (over: Partial<StageRow> & { role: string }): StageRow => ({
  runs: 0,
  completed: 0,
  failed: 0,
  escalated: 0,
  sentBack: 0,
  cancelled: 0,
  interrupted: 0,
  ...timed,
  ...over,
});
const reviewer = (over: Partial<ReviewerRow> & { role: string }): ReviewerRow => ({
  runs: 0,
  pass: 0,
  changes: 0,
  ...timed,
  ...over,
});
const NO_MODELS = {
  byModel: { challengers: [], reviewers: [], builders: [], authorTotals: [] },
  notes: [],
  coordinator: null,
  other: null,
  attributed: { sessions: 0, of: 0 },
};
let AGENTS: AgentsView;
let runs: RunsView;
const SOME_UNMEASURED: AgentsView = {
  ...NO_MODELS,
  reviewers: [
    reviewer({ role: 'spec-challenger', runs: 3, pass: 2, changes: 1, unmeasured: 3 }),
    reviewer({ role: 'security' }),
  ],
  stages: [
    stage({
      role: 'spec-writer',
      runs: 2,
      completed: 2,
      averageMs: 60_000,
      medianMs: 60_000,
      totalMs: 120_000,
      tokens: { input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 },
    }),
  ],
};

let gets: string[];
beforeEach(() => {
  gets = [];
  AGENTS = SOME_UNMEASURED;
  runs = RUNS;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : '';
      gets.push(url);
      const body =
        url === '/api/runs'
          ? runs
          : url === '/api/agents'
            ? AGENTS
            : url === '/api/runner'
              ? { controllers: [], last: null, build: null, waiting: [] }
              : [];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(hash: string) {
  window.location.hash = hash;
  render(
    <ThemeProvider theme={theme} defaultMode="light">
      <App refreshMs={50} />
    </ThemeProvider>,
  );
  const nav = screen.getByRole('navigation', { name: 'Sections' });
  return (name: string) => within(nav).getByRole('link', { name });
}

describe('Runs and Agents sections', () => {
  it('lists every section', () => {
    const link = mount('');
    for (const [name, href] of [
      ['Jobs', '#/'],
      ['Tickets', '#/tickets'],
      ['Runs', '#/runs'],
      ['Agents', '#/agents'],
    ] as const) {
      expect(link(name)).toHaveAttribute('href', href);
    }
  });

  it('renders the Runs table; null metrics read Unavailable', async () => {
    const link = mount('#/runs');
    expect(link('Runs')).toHaveAttribute('aria-current', 'page');
    expect(link('Jobs')).not.toHaveAttribute('aria-current');
    const table = await screen.findByRole('table', { name: 'Runs' });
    const value = (label: string) =>
      within(table).getByRole('rowheader', { name: label }).nextElementSibling?.textContent;
    expect(value('Total jobs')).toBe('5');
    expect(value('Completion rate (completed / finished)')).toBe('75.0%');
    expect(value('Average duration (completed)')).toBe('2h 0m');
    expect(value('Median duration (completed)')).toBe('Unavailable');
    expect(value('Completed per hour')).toBe('Unavailable');
    // The board and its controls rest while another section is open.
    expect(screen.queryByLabelText('Summary')).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Filter' })).toBeNull();
    expect(gets).not.toContain('/api/jobs');
  });

  it('renders Trust and cost, Full against Fast, with its coverage caption (ticket 0084 AC4)', async () => {
    mount('#/runs');
    const table = await screen.findByRole('table', { name: 'Trust and cost' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Metric', 'Full', 'Fast']);
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Finished jobs',
      'Escalation rate (escalated / finished)',
      'First-pass rate (first pass / merged)',
      'Rounds (median)',
      'Rounds (max)',
      'CI repairs (median)',
      'CI repairs (max)',
      'Elapsed (median)',
      'Agent time (median)',
      'Tokens (median, plain total, not weighted)',
    ]);
    const cells = (label: string) =>
      [
        ...(within(table)
          .getByRole('rowheader', { name: label })
          .closest('tr')
          ?.querySelectorAll('td') ?? []),
      ].map((c) => c.textContent);
    expect(cells('First-pass rate (first pass / merged)')).toEqual(['50.0%', 'Unavailable']);
    expect(cells('Tokens (median, plain total, not weighted)')).toEqual(['330', 'Unavailable']);
    expect(screen.getByText(/tokens recorded for 1 of 2 merged tickets/)).toHaveTextContent(
      /medians and maxima cover the merged tickets with a recorded value/,
    );
  });

  it('renders Merged tickets with a job link and weighted tokens (ticket 0084 AC5)', async () => {
    mount('#/runs');
    const table = await screen.findByRole('table', { name: 'Merged tickets' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Ticket',
      'Job',
      'Mode',
      'Jobs',
      'Rounds',
      'CI repairs',
      'Escalated',
      'Elapsed',
      'Agent time',
      'Weight',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((c) => c.textContent);
    // 300 * 1 + 30 * 5 = 450 by the Usage section's WEIGHTS.
    expect(rows.map(cells)).toEqual([
      ['0007 Export CSV', 'job-0000abcd', 'full', '2', '2', '1', 'Yes', '2h 0m', '3m', '450'],
      [
        '0008 Plain',
        'job-0000abce',
        'full',
        '1',
        '1',
        '0',
        'No',
        'Unavailable',
        'Unavailable',
        'Unavailable',
      ],
    ]);
    expect(within(table).getByRole('link', { name: 'job-0000abcd' })).toHaveAttribute(
      'href',
      '#/jobs/job-0000abcd',
    );
  });

  it('says so when no ticket has merged yet', async () => {
    runs = { ...RUNS, tickets: [] };
    mount('#/runs');
    const table = await screen.findByRole('table', { name: 'Merged tickets' });
    expect(within(table).getByText('No merged tickets yet.')).toBeInTheDocument();
  });

  it('renders Reviewers and Stages tables with plain outcome columns', async () => {
    const link = mount('#/agents');
    expect(link('Agents')).toHaveAttribute('aria-current', 'page');
    const reviewers = await screen.findByRole('table', { name: 'Reviewers' });
    const stages = screen.getByRole('table', { name: 'Stages' });
    expect(screen.queryByRole('table', { name: 'Agents' })).toBeNull();
    const headers = (t: HTMLElement) =>
      within(t)
        .getAllByRole('columnheader')
        .map((h) => h.textContent);
    expect(headers(reviewers)).toEqual([
      'Role',
      'Runs',
      'Pass',
      'Changes',
      'Average',
      'Median',
      'Total time',
      'Tokens',
    ]);
    expect(headers(stages)).toEqual([
      'Role',
      'Runs',
      'Completed',
      'Failed',
      'Escalated',
      'Sent back',
      'Cancelled',
      'Interrupted',
      'Average',
      'Median',
      'Total time',
      'Tokens',
    ]);
    const cells = (t: HTMLElement, role: string) => {
      const r = within(t).getByRole('rowheader', { name: role }).closest('tr');
      if (!r) throw new Error(`no row for ${role}`);
      return [...r.querySelectorAll('td')].map((c) => c.textContent);
    };
    expect(cells(reviewers, 'spec-challenger')).toEqual([
      '3',
      '2',
      '1 (33%)',
      'Unavailable',
      'Unavailable',
      'Unavailable',
      'Unavailable',
    ]);
    expect(cells(reviewers, 'security')).toEqual([
      '0',
      '0',
      '0',
      'Unavailable',
      'Unavailable',
      'Unavailable',
      'Unavailable',
    ]);
    expect(within(stages).queryByRole('rowheader', { name: 'spec-challenger' })).toBeNull();
    // Tokens are the Usage weight: 1000 input x 1 + 100 output x 5.
    expect(cells(stages, 'spec-writer')).toEqual([
      '2',
      '2',
      '0',
      '0',
      '0',
      '0',
      '0',
      '1m',
      '1m',
      '2m',
      (1500).toLocaleString(),
    ]);
    for (const old of ['Invocations', 'Measured', 'Open', 'Success', 'Failure', 'Other']) {
      expect(screen.queryByRole('columnheader', { name: old })).toBeNull();
    }
    expect(screen.queryByText('Not recorded')).toBeNull();
    expect(
      screen.getByText('Stage time includes coordinator work; stage Tokens do not.'),
    ).toBeInTheDocument();
    // Only the Reviewers table has runs without a duration.
    expect(screen.getAllByText(/^Runs without a duration/).map((c) => c.textContent)).toEqual([
      'Runs without a duration, left out of Average and Median: spec-challenger 3.',
    ]);
  });

  it('names the coordinator and other totals and the attributed share', async () => {
    AGENTS = {
      ...SOME_UNMEASURED,
      coordinator: { input: 200, output: 0, cacheRead: 0, cacheCreation: 0 },
      other: { input: 0, output: 1, cacheRead: 0, cacheCreation: 0 },
      attributed: { sessions: 3, of: 7 },
    };
    mount('#/agents');
    const caption = await screen.findByText(/tokens attributed for/);
    expect(caption.textContent).toContain('coordinator 200, other 5;');
    expect(caption.textContent).toContain('tokens attributed for 3 of 7 recorded sessions.');
  });

  it('reads Unavailable for coordinator and other before any session is attributed', async () => {
    mount('#/agents');
    const caption = await screen.findByText(/tokens attributed for/);
    expect(caption.textContent).toContain('coordinator Unavailable, other Unavailable;');
    expect(caption.textContent).toContain('tokens attributed for 0 of 0 recorded sessions.');
  });

  it('shows no unmeasured caption when every run has a duration', async () => {
    AGENTS = {
      ...NO_MODELS,
      reviewers: [reviewer({ role: 'security', runs: 1, pass: 1, averageMs: 1, medianMs: 1 })],
      stages: SOME_UNMEASURED.stages,
    };
    mount('#/agents');
    await screen.findByRole('table', { name: 'Reviewers' });
    expect(screen.queryByText(/Runs without a duration/)).toBeNull();
  });

  it('renders per-model tables, notes, and their captions', async () => {
    const reviewerModel: ReviewerModelRow = {
      role: 'security',
      model: 'opus',
      sameAsAuthor: true,
      fellBack: false,
      reviews: 41,
      objections: 2,
      objectionRate: 2 / 41,
      onlyObjector: 1,
      realCatches: 1,
      fixed: 0,
      unresolved: 1,
      falseAlarms: { total: 1, declined: 0, overruled: 1, vanished: 0 },
      escapes: { total: 1, ciRepair: 0, bug: 0, revert: 1 },
      medianMs: 60_000,
    };
    const builderModel = (model: string, meanTokens: number | null): BuilderModelRow => ({
      role: 'builder',
      model,
      sameAsAuthor: null,
      fellBack: model === 'sonnet',
      jobs: 4,
      firstPassRate: 0.5,
      meanRounds: 1.5,
      meanCiRepairs: 0.25,
      escalationsPerJob: 0,
      tokenJobs: meanTokens === null ? 0 : 2,
      meanTokens,
    });
    AGENTS = {
      ...SOME_UNMEASURED,
      byModel: {
        challengers: [],
        reviewers: [reviewerModel, { ...reviewerModel, model: null, sameAsAuthor: null }],
        builders: [
          builderModel('opus', 1500),
          builderModel('fable', null),
          builderModel('sonnet', 9),
        ],
        authorTotals: [],
      },
      notes: [
        {
          role: 'security',
          text: 'security on sonnet vs opus: 0 objections in 41 reviews vs 2 in 40; too few reviews to tell.',
          n: 40,
          confidence: 'low',
        },
      ],
    };
    mount('#/agents');
    const table = await screen.findByRole('table', { name: 'Reviewers by model' });
    const rows = within(table).getAllByRole('row');
    expect(rows[0]?.textContent).toContain('Real catches');
    expect([...(rows[1]?.querySelectorAll('th, td') ?? [])].map((c) => c.textContent)).toEqual([
      'security',
      'opus',
      'same',
      '41',
      '2 (5%)',
      '1',
      '1',
      '0',
      '1',
      '1 (declined 0, overruled 1, vanished 0)',
      '1 (CI repair 0, bug 0, revert 1)',
      '1m',
    ]);
    expect(within(table).getAllByText('not recorded')).toHaveLength(1);
    expect(
      screen.getByText(
        'security on sonnet vs opus: 0 objections in 41 reviews vs 2 in 40; too few reviews to tell. (n=40, low confidence)',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Tokens per model are not measured for reviewers; the per-role Tokens above are.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/orch records no Git revert/)).toBeInTheDocument();
    const builders = screen.getByRole('table', { name: 'Builders by model' });
    const tokens = (m: string) =>
      within(builders)
        .getAllByRole('row')
        .find((r) => r.textContent.includes(m))
        ?.querySelectorAll('td');
    expect(tokens('opus')?.[6]?.textContent).toBe('1,500 (2 of 4 jobs)');
    expect(tokens('fable')?.[6]?.textContent).toBe('Unavailable');
    // A row from jobs where a role left its drawn model says so (ticket 0179).
    expect(tokens('sonnet')?.[0]?.textContent).toBe('sonnet (fell back)');
    expect(tokens('opus')?.[0]?.textContent).toBe('opus');
  });
});
