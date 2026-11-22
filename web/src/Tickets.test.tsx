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

import type {
  BoardRow,
  RunnerStatus,
  TicketEvent,
  TicketJob,
  TicketView,
} from '../../src/server/types.ts';
import { App } from './App.tsx';
import { theme } from './main.tsx';

// The full suite runs ~20 process-heavy files in parallel; the 1 s default flakes under that load.
configure({ asyncUtilTimeout: 10_000 });

const ALPHA = 'github.com/acme/alpha';
const BETA = 'github.com/acme/beta';

function ticket(over: Partial<TicketView> & { id: number }): TicketView {
  return {
    repo: ALPHA,
    repoPath: '/r/alpha',
    title: `Ticket ${String(over.id)}`,
    status: 'open',
    type: 'feature',
    area: 'web',
    priority: 'P3',
    effort: 1,
    duplicateOf: null,
    classified: 'auto',
    body: '',
    importSource: null,
    importId: null,
    revision: 1,
    createdAt: '2026-11-20T08:00:00.000Z',
    updatedAt: '2026-11-20T08:00:00.000Z',
    dependsOn: [],
    related: [],
    key: String(over.id).padStart(4, '0'),
    ready: (over.status ?? 'open') === 'open',
    blockedBy: [],
    activeJob: null,
    ...over,
  };
}

/** Only what the Tickets section reads of a board row. */
function job(n: number, over: Partial<BoardRow> = {}): BoardRow {
  return {
    id: `job-0000000${String(n)}`,
    ticketId: n,
    title: `Job ${String(n)}`,
    repo: ALPHA,
    repoPath: '/r/alpha',
    stage: 'build',
    status: 'running',
    liveness: 'running',
    outcome: null,
    updatedAt: '2026-11-20T09:00:00.000Z',
    pr: { url: null, state: null, phase: 'no-pr', refreshable: false },
    ...over,
  } as BoardRow;
}

const idle = (over: Partial<RunnerStatus> = {}): RunnerStatus => ({
  state: 'idle',
  pid: null,
  mode: null,
  repo: null,
  startedAt: null,
  stop: { next: false, now: false },
  current: null,
  next: 'Nothing is running. orch start takes the next ready ticket.',
  last: null,
  ...over,
});

interface Refusal {
  status: number;
  type: string;
  message: string;
}
let db: {
  tickets: TicketView[];
  /** The server's order of the open tickets. */
  order: number[];
  rows: BoardRow[];
  runner: RunnerStatus;
  jobs: Record<number, TicketJob[]>;
  history: TicketEvent[];
  /** Every POST, in order. */
  posts: { url: string; body: Record<string, unknown> }[];
  /** The next POST is answered with this instead of being applied. */
  refuse: Refusal | null;
  gets: string[];
};

const STATUS_AFTER = {
  start: 'in-progress',
  done: 'done',
  drop: 'dropped',
  duplicate: 'duplicate',
  reopen: 'open',
} as const;

/** A stand-in for the ticket API: it applies writes plainly and validates nothing. */
function mockFetch() {
  const f = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : '';
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const summaries = (ts: TicketView[]) => ({
      total: ts.length,
      tickets: ts.map((t) => ({ ...t, body: undefined })),
    });
    const find = (n: string) => db.tickets.find((t) => t.id === Number(n));
    const missing = (n: string) =>
      json(404, { error: { type: 'NotFoundError', message: `No ticket ${n.padStart(4, '0')}` } });
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      db.posts.push({ url, body });
      if (db.refuse) {
        const { status, type, message } = db.refuse;
        db.refuse = null;
        return json(status, { error: { type, message } });
      }
      if (url === '/api/tickets') {
        const created = ticket({
          ...(body as Partial<TicketView>),
          id: Math.max(0, ...db.tickets.map((t) => t.id)) + 1,
          repo: ALPHA,
          repoPath: String(body['repo']),
        });
        db.tickets.push(created);
        return json(201, created);
      }
      const m = /^\/api\/tickets\/(\d+)\/actions$/.exec(url);
      const t = m ? find(m[1] ?? '') : undefined;
      if (!t) return missing(m?.[1] ?? '?');
      const { action, target, of, ...fields } = body;
      delete fields['revision'];
      if (action === 'edit') Object.assign(t, fields);
      else if (action === 'dep-add') t.dependsOn.push(Number(target));
      else if (action === 'dep-remove') t.dependsOn = t.dependsOn.filter((d) => d !== target);
      else if (typeof action === 'string' && action in STATUS_AFTER) {
        t.status = STATUS_AFTER[action as keyof typeof STATUS_AFTER];
        t.ready = t.status === 'open';
        t.duplicateOf = of === undefined ? null : Number(of);
      }
      t.revision++;
      return json(200, t);
    }
    db.gets.push(url);
    if (url === '/api/jobs') return json(200, db.rows);
    if (url === '/api/repos') return json(200, []);
    if (url === '/api/session') return json(200, { csrf: 'tok' });
    if (url === '/api/runner') return json(200, db.runner);
    if (url === '/api/tickets?view=all') return json(200, summaries(db.tickets));
    if (url === '/api/tickets?view=order') {
      return json(200, summaries(db.order.flatMap((n) => find(String(n)) ?? [])));
    }
    if (url === '/api/tickets/areas') {
      return json(
        200,
        ['core', 'web', 'other'].map((name) => ({ name, description: name })),
      );
    }
    const one = /^\/api\/tickets\/(\d+)(\/history)?$/.exec(url);
    if (one) {
      const t = find(one[1] ?? '');
      if (!t) return missing(one[1] ?? '');
      if (one[2]) return json(200, db.history);
      return json(200, {
        ticket: t,
        dependents: db.tickets.filter((x) => x.dependsOn.includes(t.id)).map((x) => x.id),
        jobs: db.jobs[t.id] ?? [],
        assets: [],
        assetDir: '/assets',
      });
    }
    return json(404, { error: { type: 'NotFoundError', message: `no ${url}` } });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

function mount(hash: string) {
  window.location.hash = hash;
  return render(
    <ThemeProvider theme={theme} defaultMode="light">
      <App refreshMs={50} />
    </ThemeProvider>,
  );
}
function go(hash: string) {
  window.location.hash = hash;
  fireEvent(window, new HashChangeEvent('hashchange'));
}
const table = () => screen.findByRole('table', { name: 'Tickets' });
const ids = () =>
  [...document.querySelectorAll('[data-ticket-id]')].map((r) => r.getAttribute('data-ticket-id'));
const rowOf = (n: number) => {
  const r = document.querySelector<HTMLElement>(`[data-ticket-id="${String(n)}"]`);
  if (!r) throw new Error(`no row for ticket ${String(n)}`);
  return r;
};
const stateOf = (el: HTMLElement) =>
  el.querySelector('[data-ticket-state]')?.getAttribute('data-ticket-state');
const pick = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const header = () => screen.findByTestId('ticket-header');
const lastPost = () => db.posts.at(-1);

beforeEach(() => {
  window.localStorage.clear();
  db = {
    tickets: [
      ticket({
        id: 1,
        title: 'Fix the race',
        type: 'bug',
        area: 'core',
        priority: 'P1',
        body: '## What\n\n- [ ] open item\n- [x] finished item\n',
      }),
      ticket({
        id: 2,
        title: 'Add export',
        repo: BETA,
        repoPath: '/r/beta',
        priority: 'P2',
        dependsOn: [3],
        ready: false,
        blockedBy: [
          { kind: 'dependency', ticket: 3, detail: 'depends on 0003, which is in-progress' },
        ],
      }),
      ticket({
        id: 3,
        title: 'Refactor store',
        status: 'in-progress',
        activeJob: 'job-00000003',
      }),
      ticket({ id: 4, title: 'Old thing', status: 'done' }),
      ticket({
        id: 5,
        title: 'Needs a person',
        status: 'in-progress',
        activeJob: 'job-00000005',
      }),
      ticket({ id: 6, title: 'Merged but open', status: 'in-progress' }),
      ticket({ id: 7, title: 'Waiting on CI', status: 'in-progress', activeJob: 'job-00000007' }),
      ticket({ id: 8, title: 'By hand', status: 'in-progress' }),
      ticket({ id: 9, title: 'Urgent and newest', priority: 'P1' }),
    ],
    // Not by id: only the server knows the order.
    order: [9, 1, 2],
    rows: [
      job(3),
      job(5, { stage: 'needs-human', status: 'blocked', liveness: 'blocked' }),
      job(6, {
        stage: 'completed',
        status: 'completed',
        liveness: 'completed',
        outcome: { kind: 'merged', label: 'completed: merged' },
        pr: {
          url: 'https://github.com/acme/alpha/pull/6',
          state: 'merged',
          phase: 'merged',
          refreshable: false,
        },
      }),
      job(7, { stage: 'ci', status: 'pending', liveness: 'idle' }),
    ],
    runner: idle(),
    jobs: {
      3: [
        {
          id: 'job-00000003',
          title: 'Ticket 0003: Refactor store',
          stage: 'build',
          status: 'running',
          prUrl: 'https://github.com/acme/alpha/pull/3',
          prState: 'draft',
          supersededBy: null,
          createdAt: '2026-11-20T09:00:00.000Z',
        },
      ],
    },
    history: [
      {
        id: 1,
        ticketId: 1,
        type: 'ticket.created',
        payload: { title: 'Fix the race' },
        actor: 'cli',
        createdAt: '2026-11-20T08:00:00.000Z',
      },
      {
        id: 2,
        ticketId: 1,
        type: 'ticket.priority-changed',
        payload: { from: 'P2', to: 'P1' },
        actor: 'dashboard',
        createdAt: '2026-11-20T08:05:00.000Z',
      },
    ],
    posts: [],
    refuse: null,
    gets: [],
  };
  mockFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sections', () => {
  it('offers Jobs and Tickets, and keeps the job controls in Jobs', async () => {
    db.rows = [];
    mount('');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const link = (name: string) => within(nav).getByRole('link', { name });
    expect(link('Jobs')).toHaveAttribute('aria-current', 'page');
    expect(link('Jobs')).toHaveAttribute('href', '#/');
    expect(link('Tickets')).toHaveAttribute('href', '#/tickets');
    expect(link('Tickets')).not.toHaveAttribute('aria-current');
    expect(screen.getByLabelText('Summary')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Filter' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No jobs yet');
    });
    // Nothing about tickets is asked for until the section is opened.
    expect(db.gets.some((u) => u.includes('ticket') || u.includes('runner'))).toBe(false);

    go('#/tickets');
    await table();
    expect(link('Tickets')).toHaveAttribute('aria-current', 'page');
    expect(link('Jobs')).not.toHaveAttribute('aria-current');
    expect(screen.queryByLabelText('Summary')).toBeNull();
    expect(screen.queryByRole('searchbox', { name: 'Filter' })).toBeNull();

    go('#/');
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No jobs yet');
    });
    expect(screen.queryByRole('table', { name: 'Tickets' })).toBeNull();
  });

  it('shows a useful empty state, and says why a ticket cannot be filed without a repository', async () => {
    db.tickets = [];
    db.order = [];
    db.rows = [];
    mount('#/tickets');
    expect(await screen.findByRole('status')).toHaveTextContent('No tickets yet');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No ticket is ready.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ticket' });
    expect(dialog).toHaveTextContent('No repository is known yet');
    expect(within(dialog).queryByRole('button', { name: 'Create ticket' })).toBeNull();
  });
});

describe('ticket list', () => {
  it('shows what is left in the server order, with real states, jobs, and blockers', async () => {
    mount('#/tickets');
    const t = await table();
    // In progress first, then the open tickets exactly as the server ordered them; done is hidden.
    expect(ids()).toEqual(['3', '5', '6', '7', '8', '9', '1', '2']);
    expect(
      within(t)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Queue',
      'ID',
      'Title',
      'Repository',
      'Priority',
      'State',
      'Area / Type',
      'Job',
      'Blocked by',
    ]);
    // In progress is not "running": each ticket says what its job is actually doing.
    expect([3, 5, 6, 7, 8, 9, 2].map((n) => stateOf(rowOf(n)))).toEqual([
      'running',
      'needs human',
      'merged, not closed',
      'awaiting CI',
      'in progress',
      'ready',
      'blocked',
    ]);
    const cells = (n: number) => within(rowOf(n)).getAllByRole('cell');
    expect(cells(9)[0]).toHaveTextContent(/^1$/);
    expect(cells(2)[0]).toHaveTextContent(/^3$/);
    expect(cells(3)[0]).toHaveTextContent(/^$/);
    expect(cells(1)[1]).toHaveTextContent('0001');
    expect(within(rowOf(1)).getByRole('link', { name: 'Fix the race' })).toHaveAttribute(
      'href',
      '#/tickets/1',
    );
    expect(cells(2)[3]).toHaveTextContent('beta');
    expect(cells(1)[6]).toHaveTextContent('core / bug');
    // The blocker is the server's sentence, with the ticket it names as a link.
    expect(cells(2)[8]).toHaveTextContent('depends on 0003, which is in-progress');
    expect(within(rowOf(2)).getByRole('link', { name: '0003' })).toHaveAttribute(
      'href',
      '#/tickets/3',
    );
    expect(within(rowOf(3)).getByRole('link', { name: 'job-00000003' })).toHaveAttribute(
      'href',
      '#/jobs/job-00000003',
    );
    // A merge is shown as what the job did, apart from the ticket's own state.
    expect(cells(6)[7]).toHaveTextContent('job-00000006 completed: merged');
    // The whole view costs a fixed number of requests: none is per ticket.
    await waitFor(() => {
      expect(db.gets.filter((u) => u === '/api/runner').length).toBeGreaterThan(1);
    });
    expect(new Set(db.gets)).toEqual(
      new Set([
        '/api/tickets?view=all',
        '/api/tickets?view=order',
        '/api/jobs',
        '/api/runner',
        '/api/tickets/areas',
      ]),
    );
  });

  it('filters by readiness, status, repository, priority, area, type, and text', async () => {
    mount('#/tickets');
    await table();
    expect(screen.getByLabelText('Show')).toHaveValue('current');
    expect(screen.getByRole('option', { name: 'ready (2)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'blocked (1)' })).toBeInTheDocument();
    pick('Show', 'ready');
    expect(ids()).toEqual(['9', '1']);
    pick('Show', 'blocked');
    expect(ids()).toEqual(['2']);
    pick('Show', 'done');
    expect(ids()).toEqual(['4']);
    pick('Show', 'all');
    expect(ids()).toHaveLength(9);

    pick('Show', 'current');
    pick('Repository', BETA);
    expect(ids()).toEqual(['2']);
    pick('Repository', '');
    pick('Priority', 'P1');
    expect(ids()).toEqual(['9', '1']);
    pick('Priority', '');
    pick('Area', 'core');
    expect(ids()).toEqual(['1']);
    pick('Area', '');
    pick('Type', 'bug');
    expect(ids()).toEqual(['1']);
    pick('Type', '');

    const search = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(search, { target: { value: 'EXPORT' } });
    expect(ids()).toEqual(['2']);
    fireEvent.change(search, { target: { value: '0009' } });
    expect(ids()).toEqual(['9']);
    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.getByRole('status')).toHaveTextContent(
      'No ticket matches these filters (9 in all)',
    );
  });

  it('keeps the filters across a visit to a ticket', async () => {
    mount('#/tickets');
    await table();
    pick('Show', 'ready');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'race' },
    });
    expect(ids()).toEqual(['1']);
    go('#/tickets/1');
    expect(await header()).toHaveTextContent('Fix the race');
    fireEvent.click(screen.getByRole('link', { name: '← Tickets' }));
    go('#/tickets');
    await table();
    expect(screen.getByLabelText('Show')).toHaveValue('ready');
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('race');
    expect(ids()).toEqual(['1']);
  });

  it('changes a priority from the row with its revision, then shows the order the server gives', async () => {
    mount('#/tickets');
    await table();
    db.order = [9, 2, 1];
    fireEvent.change(screen.getByLabelText('Priority of 0001'), { target: { value: 'P4' } });
    await waitFor(() => {
      expect(ids().slice(-3)).toEqual(['9', '2', '1']);
    });
    expect(db.posts).toEqual([
      { url: '/api/tickets/1/actions', body: { action: 'edit', priority: 'P4', revision: 1 } },
    ]);
    expect(screen.getByLabelText('Priority of 0001')).toHaveValue('P4');

    // A refusal is shown, and the row goes back to what the server holds.
    db.refuse = {
      status: 409,
      type: 'OwnershipError',
      message: 'Stale revision: expected 2, ticket 0001 is at 3.',
    };
    fireEvent.change(screen.getByLabelText('Priority of 0001'), { target: { value: 'P1' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ticket 0001: Stale revision: expected 2, ticket 0001 is at 3.',
    );
    expect(screen.getByLabelText('Priority of 0001')).toHaveValue('P4');
  });

  it('files a ticket for a known checkout and opens it', async () => {
    mount('#/tickets');
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'New ticket' }));
    const dialog = await screen.findByRole('dialog', { name: 'New ticket' });
    const d = within(dialog);
    const create = d.getByRole('button', { name: 'Create ticket' });
    expect(create).toBeDisabled();
    // The API takes a path: the choices are the checkouts of existing tickets and jobs.
    expect(
      within(d.getByLabelText('Repository'))
        .getAllByRole('option')
        .map((o) => [o.getAttribute('value'), o.textContent]),
    ).toEqual([
      ['/r/alpha', `${ALPHA} (/r/alpha)`],
      ['/r/beta', `${BETA} (/r/beta)`],
    ]);
    fireEvent.change(d.getByLabelText(/^Title/), { target: { value: 'Brand new' } });
    fireEvent.change(d.getByLabelText('Repository'), { target: { value: '/r/beta' } });
    fireEvent.change(d.getByLabelText('Priority'), { target: { value: 'P2' } });
    fireEvent.change(d.getByLabelText('Description (Markdown)'), {
      target: { value: '- [ ] first' },
    });

    db.refuse = { status: 422, type: 'ValidationError', message: 'area must be one of core, web' };
    fireEvent.click(create);
    expect(await d.findByRole('alert')).toHaveTextContent('area must be one of core, web');
    expect(db.tickets).toHaveLength(9);

    fireEvent.click(create);
    expect(await header()).toHaveTextContent('Brand new');
    expect(window.location.hash).toBe('#/tickets/10');
    expect(lastPost()).toEqual({
      url: '/api/tickets',
      body: {
        title: 'Brand new',
        repo: '/r/beta',
        type: 'feature',
        area: 'other',
        priority: 'P2',
        effort: 1,
        body: '- [ ] first',
      },
    });
  });
});

describe('factory status', () => {
  const region = () => screen.findByRole('region', { name: 'Factory status' });
  const stateIs = async (state: string) => {
    const r = await region();
    await waitFor(() => {
      expect(r.querySelector('[data-runner]')).toHaveAttribute('data-runner', state);
    });
    return r;
  };

  it('shows idle, running, a stop request, and an interrupted session, with no control', async () => {
    db.runner = idle({
      last: {
        at: '2026-11-20T07:00:00.000Z',
        reason: 'no ready ticket is left',
        completed: 2,
        attempted: 3,
      },
    });
    mount('#/tickets');
    let r = await stateIs('idle');
    expect(r).toHaveTextContent('Nothing is running. orch start takes the next ready ticket.');
    expect(r).toHaveTextContent('no ready ticket is left (2 of 3 attempted tickets done)');
    // The first ready ticket of the queue, never promised as what runs next.
    expect(r).toHaveTextContent('Highest-priority ready ticket: 0009 Urgent and newest (2 ready)');
    expect(r).not.toHaveTextContent(/next ticket/i);
    expect(within(r).getByRole('link', { name: '0009' })).toHaveAttribute('href', '#/tickets/9');

    db.runner = idle({
      state: 'running',
      pid: 4242,
      mode: 'queue',
      startedAt: '2026-11-20T09:00:00.000Z',
      stop: { next: true, now: false },
      current: {
        ticket: '0003',
        job: 'job-00000003',
        repo: ALPHA,
        stage: 'build',
        status: 'running',
        waiting: 'agent',
        childPid: 5,
        childAlive: true,
      },
      next: 'Run the job through the factory, then exit.',
    });
    r = await stateIs('running');
    expect(r).toHaveTextContent('queue of every repository');
    expect(r).toHaveTextContent(
      `ticket 0003 Refactor store · job-00000003 at build (running) · ${ALPHA} · waiting for agent`,
    );
    expect(within(r).getByRole('link', { name: '0003' })).toHaveAttribute('href', '#/tickets/3');
    expect(within(r).getByRole('link', { name: 'job-00000003' })).toHaveAttribute(
      'href',
      '#/jobs/job-00000003',
    );
    expect(r).toHaveTextContent('stop requested: after this ticket');
    expect(r).toHaveTextContent('Run the job through the factory, then exit.');

    db.runner = idle({
      state: 'interrupted',
      mode: 'ticket',
      stop: { next: false, now: true },
      current: {
        ticket: '0005',
        job: 'job-00000005',
        repo: ALPHA,
        stage: 'needs-human',
        status: 'blocked',
        waiting: 'human',
        childPid: null,
        childAlive: false,
      },
      next: 'The controller is gone. orch resume continues the session; orch stop discards it.',
    });
    r = await stateIs('interrupted');
    expect(r).toHaveTextContent('one ticket (orch do)');
    expect(r).toHaveTextContent('waiting for a person');
    expect(r).toHaveTextContent('stop requested: now');
    expect(r).toHaveTextContent('orch resume continues the session');
    // Visibility only: the CLI starts, stops, and resumes.
    expect(within(r).queryAllByRole('button')).toHaveLength(0);
    expect(db.posts).toEqual([]);
  });
});

describe('ticket detail', () => {
  it('opens from its URL with the description, read-only checklist, links, jobs, and history', async () => {
    mount('#/tickets/1');
    const h = await header();
    expect(h).toHaveTextContent('Fix the race');
    expect(h).toHaveTextContent('0001');
    expect(h).toHaveTextContent(`${ALPHA} · open · P1 · bug · core · 1 d`);
    expect(stateOf(h)).toBe('ready');
    const description = screen.getByRole('region', { name: 'Description' });
    const boxes = within(description).getAllByRole('checkbox');
    expect(boxes.map((b) => [(b as HTMLInputElement).checked, b.hasAttribute('disabled')])).toEqual(
      [
        [false, true],
        [true, true],
      ],
    );
    expect(description).toHaveTextContent('open item');
    expect(description).not.toHaveTextContent('[ ]');
    expect(description).not.toHaveTextContent('[x]');
    // Clicking a box changes nothing: the checklist is edited as Markdown.
    for (const box of boxes) fireEvent.click(box);
    expect(db.posts).toEqual([]);
    const history = screen.getByRole('region', { name: 'History' });
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      '2026-11-20 08:00 · cli created title: Fix the race',
      '2026-11-20 08:05 · dashboard priority-changed P2 → P1',
    ]);
    expect(screen.getByRole('region', { name: 'Jobs' })).toHaveTextContent(
      'No job has worked on this ticket.',
    );
  });

  it('explains a blocked ticket and links its dependencies, dependents, and jobs', async () => {
    mount('#/tickets/2');
    const h = await header();
    expect(stateOf(h)).toBe('blocked');
    const why = screen.getByTestId('ticket-blockers');
    expect(why).toHaveTextContent('depends on 0003, which is in-progress');
    expect(within(why).getByRole('link', { name: '0003' })).toHaveAttribute('href', '#/tickets/3');
    const links = screen.getByRole('region', { name: 'Links' });
    await waitFor(() => {
      expect(within(links).getByRole('link', { name: /0003 Refactor store/ })).toHaveAttribute(
        'href',
        '#/tickets/3',
      );
    });

    go('#/tickets/3');
    await waitFor(() => {
      expect(screen.getByTestId('ticket-header')).toHaveTextContent('Refactor store');
    });
    // What depends on this one, and the jobs that worked on it, each a link.
    expect(
      within(screen.getByRole('region', { name: 'Links' })).getByRole('link', {
        name: /0002 Add export/,
      }),
    ).toHaveAttribute('href', '#/tickets/2');
    const jobs = within(screen.getByRole('table', { name: 'Jobs of this ticket' }));
    expect(jobs.getByRole('link', { name: 'job-00000003' })).toHaveAttribute(
      'href',
      '#/jobs/job-00000003',
    );
    expect(jobs.getByRole('link', { name: 'draft' })).toHaveAttribute(
      'href',
      'https://github.com/acme/alpha/pull/3',
    );
    expect(jobs.getAllByRole('row')[1]).toHaveTextContent('build');
    expect(screen.getByRole('link', { name: '← Tickets' })).toHaveAttribute('href', '#/tickets');
  });

  it('says so when the ticket does not exist', async () => {
    mount('#/tickets/999');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('There is no ticket 0999.');
    expect(within(alert).getByRole('link', { name: '← Tickets' })).toHaveAttribute(
      'href',
      '#/tickets',
    );
  });

  it('edits fields and the Markdown body in one form, sending only what changed', async () => {
    mount('#/tickets/1');
    await header();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = within(screen.getByRole('form', { name: 'Edit ticket 0001' }));
    const body = form.getByLabelText('Description (Markdown)');
    // The raw Markdown, exactly.
    expect(body).toHaveValue('## What\n\n- [ ] open item\n- [x] finished item\n');
    fireEvent.change(form.getByLabelText('Title'), { target: { value: 'Fix the race for good' } });
    fireEvent.change(form.getByLabelText('Priority'), { target: { value: 'P2' } });
    fireEvent.change(form.getByLabelText('Effort (days)'), { target: { value: '2' } });
    fireEvent.change(body, { target: { value: '## What\n\n- [x] open item\n' } });

    // Polls keep arriving while the form is open; none of them touches the draft.
    const polls = db.gets.filter((u) => u === '/api/tickets/1').length;
    await waitFor(() => {
      expect(db.gets.filter((u) => u === '/api/tickets/1').length).toBeGreaterThan(polls + 2);
    });
    expect(form.getByLabelText('Title')).toHaveValue('Fix the race for good');
    expect(body).toHaveValue('## What\n\n- [x] open item\n');
    expect(db.posts).toEqual([]);

    fireEvent.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('form')).toBeNull();
    });
    expect(db.posts).toEqual([
      {
        url: '/api/tickets/1/actions',
        body: {
          action: 'edit',
          title: 'Fix the race for good',
          priority: 'P2',
          effort: 2,
          body: '## What\n\n- [x] open item\n',
          revision: 1,
        },
      },
    ]);
    expect(await header()).toHaveTextContent('Fix the race for good');
    expect(await header()).toHaveTextContent('P2 · bug · core · 2 d');

    // Cancel sends nothing, and so does a Save that changed nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Thrown away' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Fix the race for good');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('form')).toBeNull();
    });
    expect(db.posts).toHaveLength(1);
  });

  it('never overwrites a ticket changed elsewhere: the draft is kept and the conflict shown', async () => {
    mount('#/tickets/1');
    await header();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My title' } });
    // Someone else changed the ticket meanwhile; the server refuses the stale revision.
    const other = db.tickets.find((t) => t.id === 1);
    if (!other) throw new Error('fixture has no ticket 1');
    other.priority = 'P4';
    other.revision = 2;
    db.refuse = {
      status: 409,
      type: 'OwnershipError',
      message: 'Stale revision: expected 1, ticket 0001 is at 2.',
    };
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ticket 0001 was changed elsewhere while you were editing, so nothing was saved. Your draft is kept.',
    );
    expect(lastPost()?.body).toEqual({ action: 'edit', title: 'My title', revision: 1 });
    expect(other.title).toBe('Fix the race');
    expect(screen.getByLabelText('Title')).toHaveValue('My title');
    // The current ticket is on screen next to the draft.
    await waitFor(() => {
      expect(screen.getByTestId('ticket-header')).toHaveTextContent('P4 · bug');
    });

    // A second, deliberate Save applies only the user's own change, on the current revision.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('form')).toBeNull();
    });
    expect(lastPost()?.body).toEqual({ action: 'edit', title: 'My title', revision: 2 });
    expect(other).toMatchObject({ title: 'My title', priority: 'P4' });
  });

  it('adds and removes dependencies by id, and shows the server refusing one', async () => {
    mount('#/tickets/2');
    await header();
    const links = () => within(screen.getByRole('region', { name: 'Links' }));
    const add = links().getByRole('button', { name: 'Add dependency' });
    expect(add).toBeDisabled();
    fireEvent.change(links().getByLabelText('Ticket id'), { target: { value: '1' } });
    fireEvent.click(add);
    expect(await links().findByRole('link', { name: /0001 Fix the race/ })).toBeInTheDocument();
    expect(lastPost()).toEqual({
      url: '/api/tickets/2/actions',
      body: { action: 'dep-add', target: '1', revision: 1 },
    });
    expect(links().getByLabelText('Ticket id')).toHaveValue('');

    const chip = links().getByRole('link', { name: /0003 Refactor store/ });
    fireEvent.click(within(chip).getByTestId('CancelIcon'));
    await waitFor(() => {
      expect(links().queryByRole('link', { name: /0003/ })).toBeNull();
    });
    expect(lastPost()?.body).toEqual({ action: 'dep-remove', target: 3, revision: 2 });
    expect(window.location.hash).toBe('#/tickets/2');

    db.refuse = {
      status: 422,
      type: 'ValidationError',
      message: 'Dependency cycle: 0002 -> 0009 -> 0002. Nothing was changed.',
    };
    fireEvent.change(links().getByLabelText('Ticket id'), { target: { value: '9' } });
    fireEvent.click(links().getByRole('button', { name: 'Add dependency' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dependency cycle: 0002 -> 0009 -> 0002. Nothing was changed.',
    );
    expect(links().queryByRole('link', { name: /0009/ })).toBeNull();
    // What the user typed stays, to be corrected.
    expect(links().getByLabelText('Ticket id')).toHaveValue('9');

    fireEvent.click(links().getByRole('button', { name: 'Add related' }));
    await waitFor(() => {
      expect(lastPost()?.body).toMatchObject({ action: 'related-add', target: '9' });
    });
  });

  it('offers the lifecycle actions of the status, confirms the consequential ones, and shows a refusal', async () => {
    mount('#/tickets/1');
    await header();
    const actions = () =>
      ['Start', 'Done', 'Drop', 'Mark duplicate', 'Reopen'].filter(
        (name) => screen.queryByRole('button', { name }) !== null,
      );
    expect(actions()).toEqual(['Start', 'Done', 'Drop', 'Mark duplicate']);
    // Start is the ticket's own status change; it says it starts no job.
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAttribute(
      'title',
      expect.stringContaining('does not start a job'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Drop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Drop ticket 0001?' });
    expect(db.posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Drop ticket' }));
    await waitFor(() => {
      expect(actions()).toEqual(['Reopen']);
    });
    expect(lastPost()?.body).toEqual({ action: 'drop', revision: 1 });
    expect(stateOf(await header())).toBe('dropped');

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => {
      expect(actions()).toContain('Mark duplicate');
    });
    expect(lastPost()?.body).toEqual({ action: 'reopen', revision: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Mark duplicate' }));
    const dup = await screen.findByRole('dialog', { name: 'Mark ticket 0001 a duplicate?' });
    const confirm = within(dup).getByRole('button', { name: 'Mark duplicate' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dup).getByLabelText('Duplicate of (ticket id)'), {
      target: { value: '9' },
    });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(screen.getByTestId('ticket-header')).toHaveTextContent('duplicate of 0009');
    });
    expect(lastPost()?.body).toEqual({ action: 'duplicate', of: '9', revision: 3 });

    // The server decides: its refusal is shown word for word and nothing changes.
    go('#/tickets/3');
    await waitFor(() => {
      expect(screen.getByTestId('ticket-header')).toHaveTextContent('Refactor store');
    });
    expect(actions()).toEqual(['Done', 'Drop', 'Mark duplicate', 'Reopen']);
    db.refuse = {
      status: 409,
      type: 'WorkflowError',
      message:
        'Job job-00000003 is still working on ticket 0003; let it finish or cancel it first.',
    };
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Job job-00000003 is still working on ticket 0003; let it finish or cancel it first.',
    );
    expect(stateOf(screen.getByTestId('ticket-header'))).toBe('running');
  });
});
