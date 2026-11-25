/** Ticket HTTP API: the same operations as the CLI behind the dashboard's guards. */
import { get as httpGet } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requestStop, writeSession } from '../src/ops/runner-state.ts';
import type { TicketDetail, TicketList, TicketView } from '../src/ops/tickets.ts';
import { type RunningServer, startServer } from '../src/server/http.ts';
import type { ApiError, BoardRow, RunnerStatus } from '../src/server/types.ts';
import { createJob } from '../src/storage/jobs.ts';
import { makeRepo, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let server: RunningServer;
let alpha: string;
let beta: string;

beforeAll(async () => {
  store = tempStore();
  alpha = makeRepo('git@github.com:acme/alpha.git');
  beta = makeRepo('git@github.com:acme/beta.git');
  server = await startServer({ store, port: 0, webRoot: tempDir('orch-web-') });
});
afterAll(async () => {
  await server.close();
  store.cleanup();
});

const origin = () => `http://127.0.0.1:${String(server.port)}`;
const get = (path: string) =>
  fetch(new URL(path, server.url), { headers: { Connection: 'close' } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(new URL(path, server.url), {
    method: 'POST',
    headers: {
      Origin: origin(),
      'Content-Type': 'application/json',
      'X-Orch-Csrf': server.csrf,
      Connection: 'close',
      ...headers,
    },
    body: JSON.stringify(body),
  });
const body = async <T>(r: Promise<Response>, status = 200): Promise<T> => {
  const res = await r;
  const data = (await res.json()) as T;
  expect([res.status, res.status === status ? '' : JSON.stringify(data)]).toEqual([status, '']);
  return data;
};
const act = (id: number, action: string, extra: Record<string, unknown> = {}) =>
  post(`/api/tickets/${String(id)}/actions`, { action, ...extra });

describe('ticket API', () => {
  it('creates, reads, and lists tickets across repositories', async () => {
    expect(await body<TicketList>(get('/api/tickets'))).toEqual({ total: 0, tickets: [] });
    const a = await body<TicketView>(
      post('/api/tickets', {
        title: 'Fix the race',
        repo: alpha,
        priority: 'P1',
        effort: 0.5,
        body: '- [ ] box',
      }),
      201,
    );
    expect(a).toMatchObject({ id: 1, key: '0001', repo: 'github.com/acme/alpha', ready: true });
    const b = await body<TicketView>(
      post('/api/tickets', { title: 'In beta', repo: beta, dependsOn: [1], related: '1' }),
      201,
    );
    expect(b).toMatchObject({ id: 2, dependsOn: [1], related: [1] });
    expect((await body<TicketDetail>(get('/api/tickets/1'))).ticket.body).toBe('- [ ] box');
    expect((await body<TicketDetail>(get('/api/tickets/0001'))).dependents).toEqual([2]);
    // No job of the ticket has completed: no merge receipt.
    expect((await body<TicketDetail>(get('/api/tickets/1'))).receipt).toBeNull();
    expect((await body<TicketList>(get('/api/tickets'))).total).toBe(2);
    const inBeta = await body<TicketList>(get(`/api/tickets?repo=${encodeURIComponent(beta)}`));
    expect(inBeta.tickets.map((t) => t.id)).toEqual([2]);
    expect(
      (await body<TicketList>(get('/api/tickets?repo=alpha&priority=P1&limit=5'))).tickets,
    ).toHaveLength(1);
    expect((await body<{ name: string }[]>(get('/api/tickets/areas'))).length).toBe(13);
  });

  it('serves the ready queue, the blocked list with reasons, history, and jobs', async () => {
    expect(
      (await body<TicketList>(get('/api/tickets?view=ready'))).tickets.map((t) => t.id),
    ).toEqual([1]);
    expect(
      (await body<TicketList>(get(`/api/tickets?view=ready&repo=${encodeURIComponent(beta)}`)))
        .total,
    ).toBe(0);
    const blocked = await body<TicketList>(get('/api/tickets?view=blocked'));
    expect(blocked.tickets).toMatchObject([
      { id: 2, blockedBy: [{ kind: 'dependency', ticket: 1 }] },
    ]);
    const job = createJob(store, {
      title: 'j',
      description: 'd',
      repo: 'github.com/acme/alpha',
      repoPath: alpha,
      baseBranch: 'main',
      ticketId: 1,
    });
    await body<ApiError>(get('/api/tickets/1/jobs'), 404);
    const history = await body<{ type: string }[]>(get('/api/tickets/1/history'));
    expect(history.map((e) => e.type)).toEqual([
      'ticket.created',
      'ticket.started',
      'ticket.job-linked',
    ]);
    // The job's own detail names its ticket.
    const detail = await body<{ job: { ticketId: number } }>(get(`/api/jobs/${job.id}`));
    expect(detail.job.ticketId).toBe(1);
  });

  it('mutates through actions with revision checks', async () => {
    const edited = await body<TicketView>(
      act(2, 'edit', { title: 'Beta work', area: 'web', revision: 1 }),
    );
    expect(edited).toMatchObject({ title: 'Beta work', area: 'web', revision: 2 });
    const stale = await body<ApiError>(act(2, 'edit', { title: 'Lost update', revision: 1 }), 409);
    expect(stale.error.type).toBe('OwnershipError');
    // Two writers with the same revision: exactly one wins.
    const race = await Promise.all([
      act(2, 'note', { text: 'a', revision: 2 }),
      act(2, 'note', { text: 'b', revision: 2 }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    await body<TicketView>(act(2, 'dep-remove', { target: 1 }));
    expect((await body<TicketView>(act(2, 'related-remove', { target: '0001' }))).related).toEqual(
      [],
    );
    expect((await body<TicketView>(act(2, 'start', { note: 'by hand' }))).status).toBe(
      'in-progress',
    );
    expect((await body<TicketView>(act(2, 'done'))).status).toBe('done');
    expect((await body<TicketView>(act(2, 'reopen'))).status).toBe('open');
    const c = await body<TicketView>(
      post('/api/tickets', { title: 'Same as beta work', repo: beta }),
      201,
    );
    expect(await body<TicketView>(act(c.id, 'duplicate', { of: 2 }))).toMatchObject({
      status: 'duplicate',
      duplicateOf: 2,
    });
    await body<ApiError>(post('/api/tickets/areas', { name: 'infra', description: 'd' }), 404);
    const last = (await body<{ type: string; actor: string }[]>(get('/api/tickets/2/history'))).at(
      -1,
    );
    expect(last).toMatchObject({ type: 'ticket.reopened', actor: 'dashboard' });
  });

  it('answers bad input with the right status and changes nothing', async () => {
    const cases: [Promise<Response>, number][] = [
      [get('/api/tickets/999'), 404],
      [get('/api/tickets/abc'), 422],
      [get('/api/tickets?status=blocked'), 422],
      [get('/api/tickets/1/nope'), 404],
      [post('/api/tickets', { title: '', repo: alpha }), 422],
      [post('/api/tickets', { title: 'No repo' }), 422],
      [post('/api/tickets', { title: 'Bad', repo: alpha, priority: 'P9' }), 422],
      [post('/api/tickets', { title: 'Not a repo', repo: store.home }), 422],
      [post('/api/tickets', ['not', 'an', 'object']), 400],
      [act(1, 'explode'), 422],
      [act(1, 'edit', { effort: 4 }), 422],
      [act(1, 'dep-add', { target: 1 }), 422],
      [act(1, 'dep-add', { target: 99 }), 422],
      [act(1, 'done'), 409], // a job is still working on it
      [act(3, 'start'), 409], // a duplicate cannot be started
      [act(999, 'note', { text: 'x' }), 404],
      [post('/api/tickets/1/unknown', {}), 404],
    ];
    for (const [request, status] of cases) expect((await request).status).toBe(status);
    expect((await body<TicketList>(get('/api/tickets'))).total).toBe(3);
  });

  it('refuses a write without the CSRF token, a same-origin Origin, or JSON', async () => {
    const payload = { title: 'Forged', repo: alpha };
    expect((await post('/api/tickets', payload, { 'X-Orch-Csrf': 'wrong' })).status).toBe(403);
    expect((await post('/api/tickets', payload, { Origin: 'http://evil.example' })).status).toBe(
      403,
    );
    expect((await post('/api/tickets', payload, { 'Content-Type': 'text/plain' })).status).toBe(
      415,
    );
    expect(
      (await post('/api/tickets/1/actions', { action: 'drop' }, { 'X-Orch-Csrf': '' })).status,
    ).toBe(403);
    // fetch() refuses to override Host, so the DNS-rebinding guard gets a raw request.
    const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
      const opts = { host: '127.0.0.1', port: server.port, path: '/api/tickets' };
      httpGet({ ...opts, headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    expect(foreignHost).toBe(400);
    expect((await body<TicketList>(get('/api/tickets'))).total).toBe(3);
  });

  it('serves the controller status read-only, and names the ticket of each job on the board', async () => {
    const runner = await body<RunnerStatus>(get('/api/runner'));
    expect(runner).toMatchObject({
      state: 'idle',
      current: null,
      stop: { next: false, now: false },
      last: null,
    });
    // The install-build check rides along; null when this checkout has no build stamp.
    expect(runner).toHaveProperty('build');
    const [job] = (await body<TicketDetail>(get('/api/tickets/1'))).jobs;
    // One request ties every job to its ticket: the Tickets view never asks per row.
    const rows = await body<BoardRow[]>(get('/api/jobs'));
    expect(rows.map((r) => [r.id, r.ticketId])).toEqual([[job?.id, 1]]);

    // A controller that died at ticket 1, with a stop left for it: what `orch status` prints.
    const at = new Date().toISOString();
    writeSession(store.paths, {
      pid: process.pid,
      startedAt: at,
      beatAt: at,
      mode: 'queue',
      repo: null,
      ticket: null,
      ticketId: 1,
      jobId: job?.id ?? null,
      child: null,
      results: [],
      skipped: [],
      finished: null,
    });
    requestStop(store.paths, 'next');
    expect(await body<RunnerStatus>(get('/api/runner'))).toMatchObject({
      state: 'interrupted',
      pid: null,
      mode: 'queue',
      stop: { next: true, now: false },
      current: { ticket: '0001', job: job?.id, stage: 'spec', waiting: 'agent' },
    });
    // Visibility only: nothing under /api/runner starts, stops, or resumes anything.
    expect((await post('/api/runner', {})).status).toBe(404);
    expect((await post('/api/runner/stop', {})).status).toBe(404);
    expect((await get('/api/runner/stop')).status).toBe(404);
    expect((await body<RunnerStatus>(get('/api/runner'))).stop).toEqual({ next: true, now: false });
  });

  it('moves a ticket in the order through the move action, behind the same guards', async () => {
    for (const title of ['Four', 'Five']) {
      await body<TicketView>(post('/api/tickets', { title, repo: alpha }), 201);
    }
    const order = async () =>
      (await body<TicketList>(get('/api/tickets?view=order'))).tickets.map((t) => t.id);
    expect(await order()).toEqual([4, 5, 2]);
    expect((await body<TicketView>(act(2, 'move', { top: true }))).rank).toBe(1);
    expect(await order()).toEqual([2, 4, 5]);
    const history = await body<{ type: string }[]>(get('/api/tickets/2/history'));
    expect(history.at(-1)).toMatchObject({ type: 'ticket.rank-changed', payload: { to: 1 } });
    const five = (await body<TicketDetail>(get('/api/tickets/5'))).ticket;
    await body<TicketView>(act(5, 'move', { up: true, revision: five.revision }));
    expect(await order()).toEqual([2, 5, 4]);
    await body<TicketView>(act(4, 'move', { before: '0002' }));
    expect(await order()).toEqual([4, 2, 5]);
    expect(
      (await body<TicketList>(get('/api/tickets?view=ready'))).tickets.map((t) => t.id),
    ).toEqual([4, 2, 5]);
    // A typed position: the final place, tickets in between shift by one.
    const four = (await body<TicketDetail>(get('/api/tickets/4'))).ticket;
    await body<TicketView>(act(4, 'move', { position: 3, revision: four.revision }));
    expect(await order()).toEqual([2, 5, 4]);
    await body<TicketView>(act(4, 'move', { position: 1 }));
    expect(await order()).toEqual([4, 2, 5]);

    const cases: [Promise<Response>, number][] = [
      [act(5, 'move', { down: true }), 422], // already last
      [act(4, 'move', { up: true }), 422], // already first
      [act(3, 'move', { top: true }), 422], // a duplicate is not open
      [act(4, 'move', {}), 422],
      [act(4, 'move', { up: true, down: true }), 422],
      [act(4, 'move', { position: 4 }), 422], // out of range
      [act(4, 'move', { position: 0 }), 422],
      [act(4, 'move', { position: 1 }), 422], // already there
      [act(4, 'move', { position: 2, up: true }), 422], // exactly one of
      [act(4, 'move', { position: 2, revision: 1 }), 409],
      [act(4, 'move', { top: true, revision: 1 }), 409],
      [act(999, 'move', { top: true }), 404],
      [post('/api/tickets/5/actions', { action: 'move', top: true }, { 'X-Orch-Csrf': '' }), 403],
      [
        post('/api/tickets/5/actions', { action: 'move', top: true }, { Origin: 'http://evil' }),
        403,
      ],
    ];
    for (const [request, status] of cases) expect((await request).status).toBe(status);
    expect(await order()).toEqual([4, 2, 5]);
  });

  it('accepts P0 and P5 in a create, an edit, and the priority filter', async () => {
    const top = await body<TicketView>(
      post('/api/tickets', { title: 'Top', repo: alpha, priority: 'P0' }),
      201,
    );
    expect(top.priority).toBe('P0');
    const low = await body<TicketView>(post('/api/tickets', { title: 'Low', repo: alpha }), 201);
    expect((await body<TicketView>(act(low.id, 'edit', { priority: 'P5' }))).priority).toBe('P5');
    const only = async (p: string) =>
      (await body<TicketList>(get(`/api/tickets?priority=${p}`))).tickets.map((t) => t.id);
    expect(await only('P5')).toEqual([low.id]);
    expect(await only('P0')).toEqual([top.id]);
    expect((await get('/api/tickets?priority=P6')).status).toBe(422);
    expect((await act(low.id, 'edit', { priority: 'P6' })).status).toBe(422);
  });
});
