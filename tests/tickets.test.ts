/** Ticket rules (pure), storage (real temporary SQLite), and the ops views. */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NotFoundError,
  OwnershipError,
  ValidationError,
  WorkflowError,
} from '../src/core/errors.ts';
import {
  blockReasons,
  DEFAULT_AREAS,
  dependencyPath,
  orderTickets,
  parseTicketId,
  type Schedulable,
  ticketKey,
  ticketTransition,
} from '../src/core/tickets.ts';
import {
  addTicket,
  addTicketArea,
  addTicketAsset,
  listTickets,
  showTicket,
  ticketAction,
  ticketAreas,
  ticketHistory,
} from '../src/ops/tickets.ts';
import { tickets } from '../src/storage/schema.ts';
import { createTicket, getTicket } from '../src/storage/tickets.ts';
import { commitFile, gitIn, makeRepo, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let alpha: string;
let beta: string;

beforeEach(() => {
  store = tempStore();
  alpha = makeRepo('git@github.com:acme/alpha.git');
  beta = makeRepo('git@github.com:acme/beta.git');
});
afterEach(() => {
  store.cleanup();
});

const add = (title: string, extra: Record<string, unknown> = {}, repo = alpha) =>
  addTicket(store, { title, repo, ...extra });
const ids = (view: string, extra: Record<string, unknown> = {}) =>
  listTickets(store, { view, ...extra }).tickets.map((t) => t.id);

describe('pure rules', () => {
  const t = (id: number, o: Partial<Schedulable> = {}): Schedulable => ({
    id,
    status: 'open',
    type: 'bug',
    area: 'video',
    priority: 'P2',
    effort: 1,
    dependsOn: [],
    ...o,
  });

  it('orders dependencies first, then priority, effort, area, id (the old index order)', () => {
    const all = [
      t(1, { priority: 'P1', effort: 2 }),
      t(2, { priority: 'P1', effort: 0.5, area: 'admin', dependsOn: [1] }),
      t(3, { status: 'duplicate' }),
      t(4, { priority: 'P1', effort: 0.5, area: 'website' }),
    ];
    expect(orderTickets(all).map((x) => x.id)).toEqual([4, 1, 2]);
    // Deterministic whatever the input order.
    expect(orderTickets([...all].reverse()).map((x) => x.id)).toEqual([4, 1, 2]);
    // An in-progress dependency no longer holds its dependent back in the proposed order.
    const started = all.map((x) => (x.id === 1 ? { ...x, status: 'in-progress' as const } : x));
    expect(orderTickets(started).map((x) => x.id)).toEqual([2, 4]);
    expect(orderTickets([t(5, { area: 'b' }), t(6, { area: 'a' })]).map((x) => x.id)).toEqual([
      6, 5,
    ]);
  });

  it('finds the path that would close a dependency cycle', () => {
    const deps = new Map([
      [3, [2]],
      [2, [1]],
    ]);
    expect(dependencyPath(deps, 3, 1)).toEqual([3, 2, 1]);
    expect(dependencyPath(deps, 1, 3)).toBeUndefined();
  });

  it('allows only the listed status changes', () => {
    expect(ticketTransition('open', 'start')).toBe('in-progress');
    expect(ticketTransition('in-progress', 'done')).toBe('done');
    expect(ticketTransition('open', 'done')).toBe('done');
    expect(ticketTransition('dropped', 'reopen')).toBe('open');
    expect(() => ticketTransition('done', 'start')).toThrow(WorkflowError);
    expect(() => ticketTransition('done', 'drop')).toThrow(/Cannot drop a ticket that is done/);
    expect(() => ticketTransition('open', 'reopen')).toThrow(WorkflowError);
  });

  it('only a done dependency is satisfied; questions, active jobs, and a missing repo block', () => {
    const facts = { dependencies: [], activeJob: null, repoProblem: null };
    expect(blockReasons({ type: 'bug' }, facts)).toEqual([]);
    const blocked = blockReasons(
      { type: 'question' },
      {
        dependencies: [
          { id: 1, status: 'done', duplicateOf: null },
          { id: 2, status: 'dropped', duplicateOf: null },
          { id: 3, status: 'duplicate', duplicateOf: 9 },
          { id: 4, status: 'in-progress', duplicateOf: null },
        ],
        activeJob: 'job-00000001',
        repoProblem: 'gone',
      },
    );
    expect(blocked.map((b) => b.kind)).toEqual([
      'dependency',
      'dependency',
      'dependency',
      'question',
      'active-job',
      'repository',
    ]);
    expect(blocked[0]?.detail).toMatch(/0002, which is dropped/);
    expect(blocked[1]?.detail).toMatch(/duplicate of 0009/);
  });

  it('reads and prints ticket ids', () => {
    expect(ticketKey(85)).toBe('0085');
    expect([
      parseTicketId('85'),
      parseTicketId('0085'),
      parseTicketId('#85'),
      parseTicketId(85),
    ]).toEqual([85, 85, 85, 85]);
    for (const bad of ['', 'x', '0', '-1', '1.5', null]) {
      expect(() => parseTicketId(bad)).toThrow(ValidationError);
    }
  });
});

describe('create, read, edit', () => {
  it('numbers tickets globally across repositories and applies defaults', () => {
    const a = add('First', { priority: 'p1', area: 'core', effort: '0.5', type: 'bug' });
    const b = add('Second', {}, beta);
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a).toMatchObject({
      key: '0001',
      repo: 'github.com/acme/alpha',
      status: 'open',
      priority: 'P1',
      effort: 0.5,
      classified: 'auto',
      revision: 1,
      ready: true,
    });
    expect(b).toMatchObject({
      repo: 'github.com/acme/beta',
      priority: 'P3',
      area: 'other',
      effort: 1,
    });
    expect(showTicket(store, '0002').ticket.title).toBe('Second');
    expect(() => showTicket(store, 9)).toThrow(NotFoundError);
  });

  it('rejects bad values and unknown references, creating nothing', () => {
    for (const bad of [
      { priority: 'P5' },
      { effort: 4 },
      { type: 'epic' },
      { area: 'nope' },
      { classified: 'maybe' },
      { title: ' ' },
      { dependsOn: [7] },
      { related: '7' },
    ]) {
      expect(() => add('T', bad)).toThrow(ValidationError);
    }
    expect(() => addTicket(store, { title: 'T', repo: tempDir() })).toThrow(
      /not inside a Git repository/,
    );
    expect(() => addTicket(store, { title: 'T' })).toThrow(/belongs to a repository/);
    expect(listTickets(store).total).toBe(0);
    // A failed create consumed no number.
    expect(add('ok').id).toBe(1);
  });

  it('keeps a Markdown body with checklists byte for byte', () => {
    const body =
      '## What\n\nText with "quotes", `code` and $vars.\n\n- [ ] one\n- [x] two\n\n## Notes\n\n- 2026-11-06: n';
    const t = add('Body', { body });
    expect(showTicket(store, t.id).ticket.body).toBe(body);
    const edited = ticketAction(store, t.id, {
      action: 'edit',
      body: body.replace('[ ] one', '[x] one'),
    });
    expect(edited.body).toContain('- [x] one');
    // History marks the body as changed without copying it.
    const last = ticketHistory(store, t.id).at(-1);
    expect(last).toMatchObject({ type: 'ticket.edited' });
    expect(JSON.stringify(last?.payload)).not.toContain('quotes');
  });

  it('records old and new values, and a priority change as its own event', () => {
    const t = add('T', { priority: 'P3', area: 'web' });
    const next = ticketAction(store, t.id, {
      action: 'edit',
      title: 'T2',
      priority: 'P1',
      area: 'core',
      effort: 2,
      classified: 'user',
      actor: 'me',
    });
    expect(next).toMatchObject({
      title: 'T2',
      priority: 'P1',
      area: 'core',
      effort: 2,
      revision: 2,
    });
    const events = ticketHistory(store, t.id);
    expect(events.map((e) => e.type)).toEqual([
      'ticket.created',
      'ticket.edited',
      'ticket.reclassified',
      'ticket.priority-changed',
    ]);
    expect(events[3]).toMatchObject({ payload: { from: 'P3', to: 'P1' }, actor: 'me' });
    expect(events[2]?.payload).toMatchObject({ area: { from: 'web', to: 'core' } });
    expect(() => ticketAction(store, t.id, { action: 'edit', title: 'T2' })).toThrow(
      /Nothing to change/,
    );
    expect(() => ticketAction(store, t.id, { action: 'edit', effort: 7 })).toThrow(ValidationError);
    expect(() => ticketAction(store, t.id, { action: 'explode' })).toThrow(ValidationError);
  });

  it('refuses a stale revision and leaves the ticket as it was', () => {
    const t = add('T');
    ticketAction(store, t.id, { action: 'note', text: 'first', revision: 1 });
    expect(() => ticketAction(store, t.id, { action: 'edit', title: 'X', revision: 1 })).toThrow(
      OwnershipError,
    );
    expect(getTicket(store.db, t.id)).toMatchObject({ title: 'T', revision: 2 });
    expect(ticketAction(store, t.id, { action: 'edit', title: 'X', revision: 2 }).revision).toBe(3);
  });

  it('rolls the whole create back when a link fails', () => {
    // The dependency check runs inside the transaction, after nothing else could have failed.
    expect(() =>
      createTicket(store, { title: 'T', repo: 'r', repoPath: alpha, dependsOn: [1, 99] }),
    ).toThrow(/0099: no such ticket/);
    expect(store.db.select().from(tickets).all()).toEqual([]);
  });

  it('adds areas next to the built-in thirteen', () => {
    expect(ticketAreas(store).map((a) => a.name)).toEqual(DEFAULT_AREAS.map((a) => a.name));
    expect(DEFAULT_AREAS).toHaveLength(13);
    addTicketArea(store, { name: 'infra', description: 'deploys' });
    expect(add('T', { area: 'infra' }).area).toBe('infra');
    expect(() => addTicketArea(store, { name: 'infra', description: 'again' })).toThrow(
      /already exists/,
    );
    expect(() => addTicketArea(store, { name: 'Bad Name', description: 'x' })).toThrow(
      ValidationError,
    );
  });

  it('copies an asset into the private ticket directory', () => {
    const t = add('T');
    const shot = commitFile(alpha, 'shot one.png', 'png') && join(alpha, 'shot one.png');
    const d = addTicketAsset(store, t.id, shot);
    expect(d.assets).toEqual(['shot-one.png']);
    expect(d.assetDir.startsWith(store.home)).toBe(true);
    expect(() => addTicketAsset(store, t.id, shot)).toThrow(/already has an asset/);
    expect(() => addTicketAsset(store, t.id, join(alpha, 'missing.png'))).toThrow(ValidationError);
  });
});

describe('lifecycle', () => {
  it('walks the status machine and records each step', () => {
    const t = add('T');
    expect(ticketAction(store, t.id, { action: 'start', note: 'by hand' }).status).toBe(
      'in-progress',
    );
    expect(() => ticketAction(store, t.id, { action: 'start' })).toThrow(WorkflowError);
    expect(ticketAction(store, t.id, { action: 'done', note: 'merged PR 1' }).status).toBe('done');
    expect(() => ticketAction(store, t.id, { action: 'drop' })).toThrow(WorkflowError);
    expect(ticketAction(store, t.id, { action: 'reopen' }).status).toBe('open');
    expect(ticketAction(store, t.id, { action: 'drop' }).status).toBe('dropped');
    const events = ticketHistory(store, t.id);
    expect(events.map((e) => e.type)).toEqual([
      'ticket.created',
      'ticket.started',
      'ticket.completed',
      'ticket.reopened',
      'ticket.dropped',
    ]);
    expect(events[2]?.payload).toMatchObject({
      from: 'in-progress',
      to: 'done',
      note: 'merged PR 1',
    });
  });

  it('marks duplicates, and reopening clears the pointer', () => {
    const a = add('A');
    const b = add('B');
    const c = add('C');
    expect(() => ticketAction(store, b.id, { action: 'duplicate' })).toThrow(ValidationError);
    expect(() => ticketAction(store, b.id, { action: 'duplicate', of: b.id })).toThrow(/itself/);
    expect(() => ticketAction(store, b.id, { action: 'duplicate', of: 99 })).toThrow(NotFoundError);
    expect(ticketAction(store, b.id, { action: 'duplicate', of: a.id })).toMatchObject({
      status: 'duplicate',
      duplicateOf: a.id,
    });
    expect(() => ticketAction(store, c.id, { action: 'duplicate', of: b.id })).toThrow(
      /itself a duplicate of 0001/,
    );
    expect(ticketAction(store, b.id, { action: 'reopen' })).toMatchObject({
      status: 'open',
      duplicateOf: null,
    });
  });
});

describe('dependencies and readiness', () => {
  it('blocks across repositories until the dependency is done, and says why', () => {
    const dep = add('Dep in beta', {}, beta);
    const t = add('Needs it', { dependsOn: [dep.id] });
    const chained = add('Needs that', { dependsOn: String(t.id) });
    expect(ids('ready')).toEqual([dep.id]);
    expect(
      listTickets(store, { view: 'blocked' }).tickets.map((x) => [x.id, x.blockedBy[0]?.detail]),
    ).toEqual([
      [t.id, 'depends on 0001, which is open'],
      [chained.id, 'depends on 0002, which is open'],
    ]);
    // In progress is not done.
    ticketAction(store, dep.id, { action: 'start' });
    expect(ids('ready')).toEqual([]);
    ticketAction(store, dep.id, { action: 'done' });
    expect(ids('ready')).toEqual([t.id]);
    expect(showTicket(store, dep.id).dependents).toEqual([t.id]);
  });

  it('a dropped or duplicate dependency keeps blocking', () => {
    const a = add('A');
    const b = add('B');
    const t = add('T', { dependsOn: [a.id, b.id] });
    ticketAction(store, a.id, { action: 'drop' });
    ticketAction(store, b.id, { action: 'duplicate', of: a.id });
    const row = listTickets(store, { view: 'blocked' }).tickets[0];
    expect(row?.id).toBe(t.id);
    expect(row?.blockedBy.map((r) => r.detail)).toEqual([
      expect.stringMatching(/0001, which is dropped/),
      expect.stringMatching(/0002, which is duplicate \(a duplicate of 0001/),
    ]);
    ticketAction(store, t.id, { action: 'dep-remove', target: a.id });
    ticketAction(store, t.id, { action: 'dep-remove', target: b.id });
    expect(ids('ready')).toEqual([t.id]);
  });

  it('refuses self, missing, repeated, and cyclic dependencies, also across repositories', () => {
    const a = add('A');
    const b = add('B', {}, beta);
    const c = add('C');
    ticketAction(store, b.id, { action: 'dep-add', target: a.id });
    ticketAction(store, c.id, { action: 'dep-add', target: b.id });
    expect(() => ticketAction(store, a.id, { action: 'dep-add', target: a.id })).toThrow(
      /its own dependency/,
    );
    expect(() => ticketAction(store, a.id, { action: 'dep-add', target: 99 })).toThrow(
      /no such ticket/,
    );
    expect(() => ticketAction(store, b.id, { action: 'dep-add', target: a.id })).toThrow(
      /already has/,
    );
    expect(() => ticketAction(store, a.id, { action: 'dep-add', target: c.id })).toThrow(
      /Dependency cycle: 0001 -> 0003 -> 0002 -> 0001/,
    );
    expect(() => ticketAction(store, a.id, { action: 'dep-remove', target: c.id })).toThrow(
      /no such dependency/,
    );
    // The refused cycle changed nothing: no link, no history, no revision.
    expect(showTicket(store, a.id).ticket).toMatchObject({ dependsOn: [], revision: 1 });
    expect(ticketHistory(store, c.id).map((e) => e.type)).toEqual([
      'ticket.created',
      'ticket.dependency-added',
    ]);
  });

  it('related links never affect readiness', () => {
    const a = add('A');
    const b = add('B');
    const r = ticketAction(store, a.id, { action: 'related-add', target: b.id });
    expect(r).toMatchObject({ related: [b.id], ready: true });
    expect(ids('ready')).toEqual([a.id, b.id]);
    expect(ticketAction(store, a.id, { action: 'related-remove', target: b.id }).related).toEqual(
      [],
    );
    expect(
      ticketHistory(store, a.id)
        .map((e) => e.type)
        .slice(1),
    ).toEqual(['ticket.related-added', 'ticket.related-removed']);
  });

  it('a question is never ready; order, filters, and paging are global and stable', () => {
    const q = add('Decide', { type: 'question', priority: 'P1' });
    const p2 = add('Later', { priority: 'P2', area: 'web' }, beta);
    const p1 = add('Now', { priority: 'P1', effort: 2 });
    const quick = add('Quick', { priority: 'P1', effort: 0.25 }, beta);
    const done = add('Old');
    ticketAction(store, done.id, { action: 'done' });
    expect(ids('order')).toEqual([quick.id, q.id, p1.id, p2.id]);
    expect(ids('ready')).toEqual([quick.id, p1.id, p2.id]);
    expect(listTickets(store, { view: 'blocked' }).tickets[0]?.blockedBy[0]?.kind).toBe('question');
    expect(ids('all')).toEqual([1, 2, 3, 4, 5]);
    expect(ids('all', { status: 'done' })).toEqual([done.id]);
    expect(ids('all', { priority: 'p1', type: 'feature' })).toEqual([p1.id, quick.id]);
    expect(ids('all', { area: 'web' })).toEqual([p2.id]);
    expect(listTickets(store, { view: 'order', limit: '2', offset: 1 })).toMatchObject({
      total: 4,
      tickets: [{ id: q.id }, { id: p1.id }],
    });
    for (const bad of [
      { status: 'blocked' },
      { view: 'kanban' },
      { limit: 0 },
      { priority: 'P9' },
    ]) {
      expect(() => listTickets(store, bad)).toThrow(ValidationError);
    }
    // A list row carries no body.
    expect(listTickets(store).tickets[0]).not.toHaveProperty('body');
  });
});

describe('repository association', () => {
  it('a linked worktree files into its primary checkout, and --repo filters by repository', () => {
    const wt = join(tempDir('orch-wt-'), 'wt');
    gitIn(alpha, 'worktree', 'add', '-q', '-b', 'side', wt);
    const fromWorktree = addTicket(store, { title: 'From a worktree' }, wt);
    const inBeta = add('In beta', {}, beta);
    expect(fromWorktree.repoPath).toBe(showTicket(store, add('From primary').id).ticket.repoPath);
    // The global list is never narrowed to the caller's repository.
    expect(ids('all')).toEqual([1, 2, 3]);
    expect(ids('all', { repo: wt })).toEqual([1, 3]);
    expect(ids('all', { repo: alpha })).toEqual([1, 3]);
    expect(ids('ready', { repo: beta })).toEqual([inBeta.id]);
    expect(ids('all', { repo: 'beta' })).toEqual([inBeta.id]);
    expect(ids('all', { repo: 'github.com/acme/alpha' })).toEqual([1, 3]);
    expect(ids('all', { repo: 'nothing-like-it' })).toEqual([]);
  });

  it('follows a remote that was added or changed after the ticket was filed', () => {
    const local = makeRepo();
    const t = addTicket(store, { title: 'No remote yet', repo: local });
    expect(t.repo).not.toContain('/');
    gitIn(local, 'remote', 'add', 'origin', 'git@github.com:acme/gamma.git');
    expect(ids('all', { repo: local })).toEqual([t.id]);
    gitIn(local, 'remote', 'set-url', 'origin', 'git@github.com:acme/delta.git');
    expect(ids('all', { repo: local })).toEqual([t.id]);
    // Re-associating is an explicit, recorded edit.
    const moved = ticketAction(store, t.id, { action: 'edit', repo: local });
    expect(moved.repo).toBe('github.com/acme/delta');
    expect(ticketHistory(store, t.id).at(-1)?.payload).toMatchObject({
      repo: { to: 'github.com/acme/delta' },
    });
  });

  it('keeps two unrelated repositories with the same directory name apart', () => {
    const [one, two] = [join(tempDir(), 'same'), join(tempDir(), 'same')];
    for (const dir of [one, two]) {
      mkdirSync(dir);
      makeRepo(undefined, dir);
    }
    const a = addTicket(store, { title: 'One', repo: one });
    const b = addTicket(store, { title: 'Two', repo: two });
    expect(a.repo).toBe(b.repo);
    expect(ids('all', { repo: one })).toEqual([a.id]);
    expect(ids('all', { repo: two })).toEqual([b.id]);
  });

  it('a missing checkout blocks the ticket without losing or changing it', () => {
    const gone = makeRepo('git@github.com:acme/gone.git');
    const t = addTicket(store, { title: 'Stranded', repo: gone });
    rmSync(gone, { recursive: true, force: true });
    const row = listTickets(store, { view: 'blocked' }).tickets[0];
    expect(row).toMatchObject({ id: t.id, status: 'open', ready: false });
    expect(row?.blockedBy[0]).toMatchObject({ kind: 'repository' });
    expect(ids('ready')).toEqual([]);
    expect(ids('all', { repo: 'gone' })).toEqual([t.id]);
    expect(getTicket(store.db, t.id)).toMatchObject({ repoPath: t.repoPath, revision: 1 });
  });

  it('a short name that fits two repositories must be spelled in full', () => {
    add('A', {}, makeRepo('git@github.com:acme/web.git'));
    add('B', {}, makeRepo('git@github.com:other/web.git'));
    expect(() => ids('all', { repo: 'web' })).toThrow(/matches several repositories/);
    expect(ids('all', { repo: 'github.com/other/web' })).toEqual([2]);
  });
});
