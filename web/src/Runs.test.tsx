// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { usePolled } from './Runs.tsx';

it('drops a response from a superseded fetcher and polls nothing while disabled', async () => {
  const slow = Promise.withResolvers<string>();
  const first = vi.fn(() => slow.promise);
  const second = vi.fn(() => Promise.resolve('second'));
  const initialProps: { f: (() => Promise<string>) | null } = { f: first };
  const { result, rerender } = renderHook(({ f }) => usePolled(f, 60_000), { initialProps });
  expect(result.current.loading).toBe(true);
  rerender({ f: second });
  await waitFor(() => {
    expect(result.current.data).toBe('second');
  });
  // The first fetcher answers late: neither its value nor an error may replace the new data.
  await act(async () => {
    slow.resolve('first');
    await slow.promise;
  });
  expect(result.current.data).toBe('second');
  expect(result.current.loading).toBe(false);

  // Disabled: no request, the last value stays, and reload() fetches nothing.
  second.mockClear();
  rerender({ f: null });
  let fresh: string | null = 'unset';
  await act(async () => {
    fresh = await result.current.reload();
  });
  expect(fresh).toBeNull();
  expect(second).not.toHaveBeenCalled();
  expect(result.current.data).toBe('second');

  // reload() resolves to the fresh value; a failure is kept raw and the value stays shown.
  const boom = new Error('boom');
  const failing = vi.fn(() => Promise.reject(boom));
  rerender({ f: failing });
  await waitFor(() => {
    expect(result.current.error).toBe(boom);
  });
  expect(result.current.data).toBe('second');
  rerender({ f: second });
  await act(async () => {
    fresh = await result.current.reload();
  });
  expect(fresh).toBe('second');
  expect(result.current.error).toBeNull();
});
