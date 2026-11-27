// @vitest-environment jsdom
/** The shared header's freshness states, with fake timers (ticket 0136). Kept short on purpose. */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { RunnerStatus } from '../../src/server/types.ts';
import { FactoryStatus } from './FactoryStatus.tsx';
import { usePolled } from './Runs.tsx';

const IDLE: RunnerStatus = { controllers: [], last: null, build: null, waiting: [] };
const T0 = Date.parse('2026-11-26T10:00:00.000Z');
const REFRESH = 4000;

/** What the next fetch does: answer, fail, or wait for the held promise. */
let next: () => Promise<RunnerStatus>;
const fetcher = () => next();

/** Exactly how App wires the box: one usePolled of the runner. */
function Header() {
  const p = usePolled(fetcher, REFRESH);
  return (
    <FactoryStatus runner={p.data} error={p.error} updatedAt={p.updatedAt} refreshMs={REFRESH} />
  );
}

const region = () => screen.queryByRole('region', { name: 'Factory status' });
const must = () => {
  const r = region();
  if (!r) throw new Error('no Factory status region');
  return r;
};
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** The warning box (glyph, message, ticking time) and its live region (static text only). */
const warningBox = () => {
  const w = must().querySelector('[data-warning]');
  if (!(w instanceof HTMLElement)) throw new Error('no warning');
  return w;
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('ages Updated while a poll is held, says Not updating past 3 polls, and recovers (AC7, AC9)', async () => {
  next = () => Promise.resolve(IDLE);
  render(<Header />);
  await advance(0);
  const r = must();
  expect(r.querySelector('[data-runner]')).toHaveAttribute('data-runner', 'idle');
  expect(r).toHaveTextContent('Updated just now');
  const time = r.querySelector('time');
  expect(time).toHaveAttribute('datetime', new Date(T0).toISOString());
  expect(time).toHaveAttribute('title', new Date(T0).toISOString());

  // The next poll hangs: the text ages with no new response.
  let held = Promise.withResolvers<RunnerStatus>();
  next = () => held.promise;
  await advance(6000);
  expect(must()).toHaveTextContent('Updated 6s ago');
  expect(within(must()).queryByRole('status')).toBeNull();
  await act(async () => {
    held.resolve(IDLE);
    await held.promise;
  });
  expect(must()).toHaveTextContent('Updated just now');
  expect(must().querySelector('time')).toHaveAttribute(
    'datetime',
    new Date(T0 + 6000).toISOString(),
  );

  // Held past 3 × refreshMs: Not updating, in text with a glyph, the last good content kept.
  held = Promise.withResolvers<RunnerStatus>();
  await advance(13_000);
  const warning = warningBox();
  const live = within(must()).getByRole('status');
  expect(warning).toContainElement(live);
  expect(warning).toHaveTextContent('⚠');
  expect(live).toHaveTextContent('Not updating');
  expect(warning).toHaveTextContent('Last updated 13s ago');
  expect(live).toHaveTextContent('retries every 4 s');
  expect(warning.querySelector('time')).toHaveAttribute(
    'datetime',
    new Date(T0 + 6000).toISOString(),
  );
  // The clock ticks: the shown time ages, the live region's text does not change.
  const said = live.textContent;
  expect(live.querySelector('time')).toBeNull();
  await advance(2000);
  expect(warningBox()).toHaveTextContent('Last updated 15s ago');
  expect(within(must()).getByRole('status').textContent).toBe(said);
  expect(must().querySelector('[data-runner]')).toHaveAttribute('data-runner', 'idle');
  expect(within(must()).queryAllByRole('button')).toHaveLength(0);
  await act(async () => {
    held.resolve(IDLE);
    await held.promise;
  });
  expect(within(must()).queryByRole('status')).toBeNull();
  expect(must()).toHaveTextContent('Updated just now');
});

it('renders nothing before the first answer; a failure warns with its text, then recovers (AC8, AC10)', async () => {
  const first = Promise.withResolvers<RunnerStatus>();
  next = () => first.promise;
  render(<Header />);
  await advance(0);
  // No region, no idle chip before the first response.
  expect(region()).toBeNull();
  expect(document.querySelector('[data-runner]')).toBeNull();

  // A failed first request: the warning, and no state chip.
  await act(async () => {
    first.reject(new Error('Factory unreachable'));
    await first.promise.catch(() => undefined);
  });
  let warning = warningBox();
  expect(warning).toContainElement(within(must()).getByRole('status'));
  expect(warning).toHaveTextContent('⚠');
  expect(within(must()).getByRole('status')).toHaveTextContent('Factory unreachable');
  expect(within(must()).getByRole('status')).toHaveTextContent('retries every 4 s');
  expect(warning).not.toHaveTextContent('Last updated');
  expect(must().querySelector('[data-runner]')).toBeNull();
  expect(within(must()).queryAllByRole('button')).toHaveLength(0);

  // The next good poll: the warning is gone and the normal content shows.
  next = () => Promise.resolve(IDLE);
  await advance(REFRESH);
  expect(within(must()).queryByRole('status')).toBeNull();
  expect(must().querySelector('[data-runner]')).toHaveAttribute('data-runner', 'idle');
  expect(must()).toHaveTextContent('Updated just now');

  // A later failure keeps the last content and names the last good update.
  next = () => Promise.reject(new Error('db locked'));
  await advance(2 * REFRESH);
  warning = warningBox();
  const live = within(must()).getByRole('status');
  expect(live).toHaveTextContent('db locked');
  expect(warning).toHaveTextContent('Last updated 8s ago');
  expect(warning.querySelector('time')).toHaveAttribute(
    'datetime',
    new Date(T0 + REFRESH).toISOString(),
  );
  expect(live).toHaveTextContent('retries every 4 s');
  expect(live.querySelector('time')).toBeNull();
  expect(must().querySelector('[data-runner]')).toHaveAttribute('data-runner', 'idle');
  expect(within(must()).queryAllByRole('button')).toHaveLength(0);
  next = () => Promise.resolve(IDLE);
  await advance(REFRESH);
  expect(within(must()).queryByRole('status')).toBeNull();
  expect(must()).toHaveTextContent('Updated just now');
});
