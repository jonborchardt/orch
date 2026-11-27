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
};

const timed = { unmeasured: 0, averageMs: null, medianMs: null };
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
};
let AGENTS: AgentsView;
const SOME_UNMEASURED: AgentsView = {
  ...NO_MODELS,
  reviewers: [
    reviewer({ role: 'spec-challenger', runs: 3, pass: 2, changes: 1, unmeasured: 3 }),
    reviewer({ role: 'security' }),
  ],
  stages: [
    stage({ role: 'spec-writer', runs: 2, completed: 2, averageMs: 60_000, medianMs: 60_000 }),
  ],
};

let gets: string[];
beforeEach(() => {
  gets = [];
  AGENTS = SOME_UNMEASURED;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : '';
      gets.push(url);
      const body = url === '/api/runs' ? RUNS : url === '/api/agents' ? AGENTS : [];
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
    expect(headers(reviewers)).toEqual(['Role', 'Runs', 'Pass', 'Changes', 'Average', 'Median']);
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
    ]);
    expect(cells(reviewers, 'security')).toEqual(['0', '0', '0', 'Unavailable', 'Unavailable']);
    expect(within(stages).queryByRole('rowheader', { name: 'spec-challenger' })).toBeNull();
    expect(cells(stages, 'spec-writer')).toEqual(['2', '2', '0', '0', '0', '0', '0', '1m', '1m']);
    for (const old of ['Invocations', 'Measured', 'Open', 'Success', 'Failure', 'Other']) {
      expect(screen.queryByRole('columnheader', { name: old })).toBeNull();
    }
    expect(screen.queryByText('Not recorded')).toBeNull();
    expect(screen.getByText('Stage time includes coordinator work.')).toBeInTheDocument();
    // Only the Reviewers table has runs without a duration.
    expect(screen.getAllByText(/^Runs without a duration/).map((c) => c.textContent)).toEqual([
      'Runs without a duration, left out of Average and Median: spec-challenger 3.',
    ]);
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
        builders: [builderModel('opus', 1500), builderModel('fable', null)],
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
        "Tokens per review are not measured: a session's tokens are recorded per job, not per agent.",
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
  });
});
