import { afterEach, expect, it, vi } from 'vitest';

import { postAction } from './api.ts';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

it('fetches a fresh CSRF token and retries once after `orch ui` restarted under an open page', async () => {
  // The token is per server process: the page cached the old one, the restarted server has a new one.
  let live = 'old';
  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/session') return Promise.resolve(json(200, { csrf: live }));
      const token = new Headers(init?.headers).get('X-Orch-Csrf') ?? '';
      sent.push(token);
      return Promise.resolve(
        token === live
          ? json(200, { ok: true })
          : json(403, { error: { type: 'HttpError', message: 'Invalid CSRF token' } }),
      );
    }),
  );

  await postAction('job-00000001', { action: 'refresh-pr' } as never);
  live = 'new';
  await expect(postAction('job-00000001', { action: 'refresh-pr' } as never)).resolves.toEqual({
    ok: true,
  });
  expect(sent).toEqual(['old', 'old', 'new']);

  // A token the server still rejects after the refetch is reported, not retried forever.
  live = 'unreachable';
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url === '/api/session'
          ? json(200, { csrf: 'stale' })
          : json(403, { error: { type: 'HttpError', message: 'Invalid CSRF token' } }),
      ),
    ),
  );
  await expect(postAction('job-00000001', { action: 'refresh-pr' } as never)).rejects.toThrow(
    'Invalid CSRF token',
  );
});
