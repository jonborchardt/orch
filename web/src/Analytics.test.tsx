// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { ThemeProvider } from '@mui/material';
import { cleanup, configure, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRow, RunsView } from '../../src/server/types.ts';
import { App } from './App.tsx';
import { theme } from './main.tsx';

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

const row = (over: Partial<AgentRow> & { role: string }): AgentRow => ({
  source: 'stage',
  invocations: 0,
  success: 0,
  failure: 0,
  other: 0,
  open: 0,
  measured: 0,
  unmeasured: 0,
  averageMs: null,
  medianMs: null,
  ...over,
});
const AGENTS: AgentRow[] = [
  row({ role: 'spec-writer', invocations: 2, success: 2, measured: 2, averageMs: 60_000 }),
  row({ role: 'spec-challenger', source: 'none' }),
  row({ role: 'security', source: 'reviews', invocations: 1, open: 1, unmeasured: 1 }),
];

let gets: string[];
beforeEach(() => {
  gets = [];
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

  it('renders the Agents table; a none row reads Not recorded', async () => {
    const link = mount('#/agents');
    expect(link('Agents')).toHaveAttribute('aria-current', 'page');
    const table = await screen.findByRole('table', { name: 'Agents' });
    const rowOf = (role: string) => {
      const r = within(table).getByRole('rowheader', { name: role }).closest('tr');
      if (!r) throw new Error(`no row for ${role}`);
      return r;
    };
    expect(rowOf('spec-writer')).toHaveTextContent('stage time (includes coordinator work)');
    expect(rowOf('spec-writer')).toHaveTextContent('1m');
    expect(rowOf('spec-challenger')).toHaveTextContent('Not recorded');
    expect(rowOf('security')).toHaveTextContent('Unavailable');
  });
});
