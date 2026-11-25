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

import type { UsageView } from '../../src/server/types.ts';
import { App } from './App.tsx';
import { theme } from './main.tsx';

configure({ asyncUtilTimeout: 10_000 });

const z = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const VIEW: UsageView = {
  hours: 24,
  buckets: [
    {
      hour: '2026-11-20T09:00:00.000Z',
      input: 10,
      output: 8,
      cacheRead: 100,
      cacheCreation: 5,
      missing: [],
    },
    { hour: '2026-11-20T10:00:00.000Z', ...z, missing: ['job-0000000b'] },
    { hour: '2026-11-20T11:00:00.000Z', ...z, missing: [] },
  ],
  total: { input: 1234, output: 8, cacheRead: 100, cacheCreation: 5, complete: false },
  jobs: [
    {
      id: 'job-0000000a',
      title: 'Alpha',
      input: 1234,
      output: 8,
      cacheRead: 100,
      cacheCreation: 5,
      missing: null,
    },
    { id: 'job-0000000b', title: 'Beta', ...z, missing: 'Transcript x.jsonl was not found.' },
  ],
};

let gets: string[];
beforeEach(() => {
  gets = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
      gets.push(url);
      const body = url.startsWith('/api/usage') ? VIEW : [];
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

describe('Usage section', () => {
  it('is the fifth section and opens at #/usage without the board polling (AC9)', async () => {
    const link = mount('#/usage');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Jobs', 'Tickets', 'Runs', 'Agents', 'Usage']);
    expect(link('Usage')).toHaveAttribute('href', '#/usage');
    expect(link('Usage')).toHaveAttribute('aria-current', 'page');
    await screen.findByRole('table', { name: 'Usage total' });
    // Wait past several poll intervals: Usage loads once, and the board never.
    await new Promise((r) => setTimeout(r, 200));
    expect(gets).toEqual(['/api/usage?hours=24']);
    expect(screen.queryByLabelText('Summary')).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Filter' })).toBeNull();
  });

  it('renders the range total per kind, missing hours in text, and per-job rows (AC8)', async () => {
    mount('#/usage');
    const table = await screen.findByRole('table', { name: 'Usage total' });
    const value = (label: string) =>
      within(table).getByRole('rowheader', { name: label }).nextElementSibling?.textContent;
    expect(value('Input')).toBe((1234).toLocaleString());
    expect(value('Output')).toBe('8');
    expect(value('Cache read')).toBe('100');
    expect(value('Cache creation')).toBe('5');
    expect(value('Total (incomplete)')).toBe((1347).toLocaleString());
    expect(screen.getByRole('img', { name: /missing data for job-0000000b/ })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /missing/ })).toHaveLength(1);
    expect(screen.getByText(/1 hour with missing data/)).toBeInTheDocument();
    const jobs = screen.getByRole('table', { name: 'Usage per job' });
    expect(within(jobs).getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'href',
      '#/jobs/job-0000000a',
    );
    expect(within(jobs).getByText('Transcript x.jsonl was not found.')).toBeInTheDocument();
  });

  it('shows the cost weight in the total, per job, and as the charted value (ticket 0145)', async () => {
    mount('#/usage');
    const table = await screen.findByRole('table', { name: 'Usage total' });
    // 1234 + 5 x 1.25 + 100 x 0.1 + 8 x 5 = 1290.25, shown whole.
    expect(
      within(table).getByRole('rowheader', { name: 'Weight' }).nextElementSibling?.textContent,
    ).toBe((1290).toLocaleString());
    const jobs = screen.getByRole('table', { name: 'Usage per job' });
    const cells = (title: string) =>
      [...(within(jobs).getByRole('link', { name: title }).closest('tr')?.cells ?? [])].map(
        (c) => c.textContent,
      );
    expect(within(jobs).getByRole('columnheader', { name: 'Weight' })).toBeInTheDocument();
    expect(cells('Alpha')[6]).toBe((1290).toLocaleString());
    expect(cells('Beta')[6]).toBe('0');
    expect(
      screen.getByText(/input-token equivalents.*approximate API price ratios, not a bill/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Estimated cost weight per hour' }),
    ).toBeInTheDocument();
    // 09:00: 10 + 5 x 1.25 + 100 x 0.1 + 8 x 5 = 66.25.
    const hour = screen
      .getAllByRole('img')
      .find((g) => g.getAttribute('aria-label')?.includes('66'));
    expect(hour?.getAttribute('aria-label')).toMatch(/weight 66 /);
    expect(hour?.getAttribute('aria-label')).not.toContain('66.25');
    if (!hour) throw new Error('no 09:00 bar');
    fireEvent.focus(hour);
    const readout = screen.getByRole('status');
    expect(readout).toHaveTextContent('weight 66;');
    expect(readout).toHaveTextContent('input 10, output 8, cache read 100, cache creation 5');
    // Y axis 0..80 in steps of 20 (top at or above 66), units named.
    expect(screen.getByText('Weight (input-token equivalents)')).toBeInTheDocument();
    const yAxis = within(screen.getByLabelText('Weight axis'));
    expect(yAxis.getAllByText(/./).map((e) => e.textContent)).toEqual([
      '0',
      '20',
      '40',
      '60',
      '80',
    ]);
    expect(within(screen.getByLabelText('Time axis')).getAllByText(/\d/).length).toBeGreaterThan(0);
  });

  it('requests hours=168 for 7 days, and again on Refresh (AC8)', async () => {
    mount('#/usage');
    await screen.findByRole('table', { name: 'Usage total' });
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => {
      expect(gets).toContain('/api/usage?hours=168');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(gets.filter((g) => g === '/api/usage?hours=168')).toHaveLength(2);
    });
  });
});
