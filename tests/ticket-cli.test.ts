/** `orch ticket` end to end: spawned from source, cwd outside this repository, temp ORCH_HOME. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { TicketDetail, TicketList, TicketView } from '../src/ops/tickets.ts';
import { json, makeRepoWithOrigin, orch, orchAsync, tempDir } from './helpers.ts';

let home: string;
let alpha: string;
let beta: string;
let outside: string;

beforeAll(() => {
  home = tempDir();
  outside = tempDir();
  alpha = makeRepoWithOrigin('git@github.com:acme/alpha.git').clone;
  beta = makeRepoWithOrigin('git@github.com:acme/beta.git').clone;
});

const run = (cwd: string, ...args: string[]) => orch(home, cwd, ['ticket', ...args, '--json']);
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller picks the shape
const ok = <T>(cwd: string, ...args: string[]): T => {
  const r = run(cwd, ...args);
  if (r.code !== 0)
    throw new Error(`orch ticket ${args.join(' ')} exited ${String(r.code)}: ${r.err}`);
  return json<T>(r);
};
const failure = (cwd: string, ...args: string[]) => {
  const r = run(cwd, ...args);
  return {
    code: r.code,
    ...(JSON.parse(r.err) as { error: { type: string; message: string } }).error,
  };
};

describe('orch ticket', () => {
  it('numbers concurrent creations from several repositories without a duplicate', async () => {
    // The database does not exist yet: every process also races to create and migrate it
    // (the retry in openStore; this failed on CI before it).
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        orchAsync(home, i % 2 ? alpha : beta, [
          'ticket',
          'add',
          `Concurrent ${String(i)}`,
          '--json',
        ]),
      ),
    );
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
    const ids = results.map((r) => json<TicketView>(r).id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('files into the cwd repository by default and prints a stable JSON shape', () => {
    const t = ok<TicketView>(
      alpha,
      'add',
      'Fix verification race',
      '--priority',
      'P1',
      '--area',
      'core',
      '--effort',
      '0.5',
      '--type',
      'bug',
    );
    expect(Object.keys(t).sort()).toEqual(
      [
        'activeJob',
        'area',
        'blockedBy',
        'body',
        'classified',
        'createdAt',
        'dependsOn',
        'duplicateOf',
        'effort',
        'id',
        'importId',
        'importSource',
        'key',
        'priority',
        'rank',
        'ready',
        'related',
        'repo',
        'repoPath',
        'revision',
        'status',
        'title',
        'type',
        'updatedAt',
      ].sort(),
    );
    expect(t).toMatchObject({
      id: 7,
      key: '0007',
      repo: 'github.com/acme/alpha',
      priority: 'P1',
      effort: 0.5,
    });
    // Outside any repository a ticket needs --repo; nothing is assigned by guesswork.
    expect(failure(outside, 'add', 'Nowhere')).toMatchObject({ code: 1, type: 'ValidationError' });
    expect(
      ok<TicketView>(outside, 'add', 'Elsewhere', '--repo', beta, '--depends-on', '7').repo,
    ).toBe('github.com/acme/beta');
  });

  it('lists globally, filters by repository, and answers ready, blocked, and next', () => {
    const all = ok<TicketList>(outside, 'list');
    expect(all.total).toBe(8);
    expect(
      ok<TicketList>(outside, 'list', '--repo', alpha).tickets.every((t) =>
        t.repo.endsWith('alpha'),
      ),
    ).toBe(true);
    expect(ok<TicketList>(alpha, 'list', '--repo', 'beta', '--limit', '2')).toMatchObject({
      total: 4,
      tickets: [{}, {}],
    });
    expect(ok<{ ticket: TicketView }>(outside, 'next').ticket.id).toBe(7);
    expect(ok<{ ticket: TicketView }>(outside, 'next', '--repo', 'beta').ticket.repo).toBe(
      'github.com/acme/beta',
    );
    const blocked = ok<TicketList>(outside, 'blocked');
    expect(blocked.tickets).toMatchObject([
      { id: 8, blockedBy: [{ kind: 'dependency', ticket: 7 }] },
    ]);
    expect(ok<TicketList>(outside, 'ready').tickets.map((t) => t.id)).not.toContain(8);
    // Text mode is a table, with the reason under a blocked ticket.
    const text = orch(home, outside, ['ticket', 'blocked']).out;
    expect(text).toMatch(/^ID +RANK +PRI +DAYS +STATUS/);
    expect(text).toContain('blocked: depends on 0007, which is open');
  });

  it('edits fields and a Markdown body from stdin, and shows the result', () => {
    const body = '## What\n\nSay "hi" to $HOME & `friends`.\n\n- [ ] one\n- [x] two\n';
    const edited = json<TicketView>(
      orch(
        home,
        outside,
        ['ticket', 'edit', '7', '--body-file', '-', '--title', 'Fix the race', '--json'],
        {},
        body,
      ),
    );
    expect(edited).toMatchObject({ title: 'Fix the race', body: body.trimEnd(), revision: 2 });
    const file = join(outside, 'body.md');
    writeFileSync(file, '## What\n\nFrom a file.\n');
    expect(
      ok<TicketView>(outside, 'edit', '0007', '--body-file', file, '--priority', 'p2').body,
    ).toBe('## What\n\nFrom a file.');
    const shown = ok<TicketDetail>(outside, 'show', '#7');
    // `here` tells a skill whether the cwd is the ticket's repository (ticket 7 is alpha's).
    expect(ok<{ here: boolean }>(outside, 'show', '7').here).toBe(false);
    expect(ok<{ here: boolean }>(beta, 'show', '7').here).toBe(false);
    expect(ok<{ here: boolean }>(alpha, 'show', '7').here).toBe(true);
    expect(shown).toMatchObject({
      ticket: { priority: 'P2', revision: 3 },
      dependents: [8],
      jobs: [],
      assets: [],
    });
    expect(ok<{ type: string }[]>(outside, 'history', '7').map((e) => e.type)).toEqual([
      'ticket.created',
      'ticket.edited',
      'ticket.edited',
      'ticket.priority-changed',
    ]);
  });

  it('runs the lifecycle, links, and notes', () => {
    expect(ok<TicketView>(outside, 'start', '7', '--note', 'by hand').status).toBe('in-progress');
    expect(ok<TicketView>(outside, 'note', '7', 'half', 'way').revision).toBe(5);
    expect(ok<TicketView>(outside, 'done', '7', '--note', 'merged').status).toBe('done');
    expect(ok<TicketList>(outside, 'ready').tickets.map((t) => t.id)).toContain(8);
    expect(ok<TicketView>(outside, 'reopen', '7').status).toBe('open');
    expect(ok<TicketView>(outside, 'dep', 'add', '1', '2').dependsOn).toEqual([2]);
    expect(ok<TicketView>(outside, 'dep', 'remove', '1', '2').dependsOn).toEqual([]);
    expect(ok<TicketView>(outside, 'related', 'add', '1', '7').related).toEqual([7]);
    expect(ok<TicketView>(outside, 'duplicate', '3', '--of', '1')).toMatchObject({
      status: 'duplicate',
      duplicateOf: 1,
    });
    expect(ok<TicketView>(outside, 'drop', '4').status).toBe('dropped');
    expect(
      ok<{ name: string }[]>(outside, 'area', 'add', 'infra', '--description', 'deploys').at(-1)
        ?.name,
    ).toBe('infra');
  });

  it('maps failures to the documented exit codes', () => {
    expect(failure(outside, 'show', '999')).toMatchObject({ code: 3, type: 'NotFoundError' });
    expect(failure(outside, 'edit', '7', '--title', 'x', '--revision', '1')).toMatchObject({
      code: 4,
      type: 'OwnershipError',
    });
    expect(failure(outside, 'edit', '7', '--effort', '4')).toMatchObject({
      code: 1,
      type: 'ValidationError',
    });
    expect(failure(outside, 'dep', 'add', '7', '8')).toMatchObject({
      code: 1,
      message: expect.stringMatching(/cycle/) as string,
    });
    expect(failure(outside, 'done', '4')).toMatchObject({ code: 1, type: 'WorkflowError' });
    expect(failure(outside, 'frobnicate')).toMatchObject({ code: 2, type: 'UsageError' });
    expect(failure(outside, 'dep', 'sideways', '1', '2').code).toBe(2);
    expect(failure(outside, 'duplicate', '5').code).toBe(2);
    expect(failure(outside, 'show').code).toBe(2);
    expect(orch(home, outside, ['ticket', '--help']).out).toContain('Usage: orch ticket <command>');
  });

  it('ranks and moves tickets in the one order, refusing moves that break it', () => {
    const h = tempDir();
    const t = (...args: string[]) => orch(h, outside, ['ticket', ...args, '--json']);
    const view = (...args: string[]) => {
      const r = t(...args);
      if (r.code !== 0) throw new Error(`orch ticket ${args.join(' ')}: ${r.err}`);
      return json<TicketView>(r);
    };
    const order = () => json<TicketList>(t('order')).tickets.map((x) => x.id);
    for (const p of ['P1', 'P2', 'P3', 'P4']) {
      expect(
        json<TicketView>(orch(h, alpha, ['ticket', 'add', p, '--priority', p, '--json'])).id,
      ).toBeGreaterThan(0);
    }
    view('add', 'After four', '--repo', alpha, '--priority', 'P3', '--depends-on', '4');
    expect(order()).toEqual([1, 2, 3, 4, 5]);

    // A rank puts a lower-priority ticket first; none takes it back out.
    expect(view('edit', '3', '--rank', '5')).toMatchObject({ rank: 5, revision: 2 });
    expect(json<{ type: string; payload: unknown }[]>(t('history', '3')).at(-1)).toMatchObject({
      type: 'ticket.rank-changed',
      payload: { from: null, to: 5 },
    });
    expect(order()).toEqual([3, 1, 2, 4, 5]);
    expect(json<{ ticket: TicketView }>(t('next')).ticket.id).toBe(3);
    expect(orch(h, outside, ['ticket', 'order']).out).toMatch(/^ID +RANK +PRI[\s\S]*\n0003 +5 +P3/);
    expect(t('edit', '3', '--rank', 'soon').code).toBe(1);
    expect(t('edit', '3', '--rank', '1', '--revision', '1').code).toBe(4);
    expect(view('edit', '3', '--rank', 'none').rank).toBeNull();
    expect(order()).toEqual([1, 2, 3, 4, 5]);

    // Top lands right after the ticket's own dependencies; the others keep their order.
    view('move', '5', '--top');
    expect(order()).toEqual([4, 5, 1, 2, 3]);
    view('move', '1', '--up');
    expect(order()).toEqual([4, 1, 5, 2, 3]);
    view('move', '1', '--down');
    expect(order()).toEqual([4, 5, 1, 2, 3]);
    view('move', '3', '--before', '1');
    expect(order()).toEqual([4, 5, 3, 1, 2]);
    view('move', '3', '--position', '5');
    expect(order()).toEqual([4, 5, 1, 2, 3]);
    view('move', '3', '--position', '3');
    expect(order()).toEqual([4, 5, 3, 1, 2]);

    // Refusals write nothing.
    const before = json<TicketList>(t('list')).tickets.map((x) => [x.id, x.revision, x.rank]);
    const refused = (...args: string[]) => {
      const r = t('move', ...args);
      return { code: r.code, message: r.err };
    };
    expect(refused('4', '--up').code).toBe(1);
    expect(refused('2', '--down').code).toBe(1);
    expect(refused('5', '--before', '4')).toMatchObject({
      code: 1,
      message: expect.stringContaining('depends on 0004') as string,
    });
    expect(refused('4', '--down').code).toBe(1);
    expect(refused('4', '--before', '4').code).toBe(1);
    expect(refused('4', '--top', '--revision', '1').code).toBe(4);
    expect(refused('4').code).toBe(2);
    expect(refused('4', '--up', '--top').code).toBe(2);
    expect(refused('3', '--position', '6').code).toBe(1);
    expect(refused('3', '--position', '0').code).toBe(1);
    expect(refused('3', '--position', '3').code).toBe(1);
    expect(refused('3', '--position', '1', '--up').code).toBe(2);
    expect(refused('999', '--top').code).toBe(3);
    expect(json<TicketList>(t('list')).tickets.map((x) => [x.id, x.revision, x.rank])).toEqual(
      before,
    );
    view('drop', '2');
    expect(refused('2', '--top').code).toBe(1);
    expect(refused('1', '--before', '2').code).toBe(1);
  });

  it('dispatches a job for a ticket and shows the association from both sides', () => {
    const d = json<{ job: { id: string; ticketId: number; repoPath: string } }>(
      orch(home, outside, ['factory', 'dispatch', '--ticket', '7', '--json']),
    );
    expect(d.job).toMatchObject({ ticketId: 7, repoPath: alpha });
    expect(ok<{ id: string }[]>(outside, 'jobs', '7')).toMatchObject([{ id: d.job.id }]);
    expect(ok<TicketDetail>(outside, 'show', '7').ticket).toMatchObject({
      status: 'in-progress',
      activeJob: d.job.id,
    });
    const second = orch(home, outside, ['factory', 'dispatch', '--ticket', '7', '--json']);
    expect(second.code).toBe(1);
    expect(second.err).toContain('is already working on it');
    const shown = json<{ job: { ticketId: number } }>(
      orch(home, outside, ['job', 'show', d.job.id, '--json']),
    );
    expect(shown.job.ticketId).toBe(7);
  });

  it('accepts P0 to P5, orders them, filters by them, and refuses anything else', () => {
    const h = tempDir();
    const t = (...args: string[]) => orch(h, alpha, ['ticket', ...args, '--json']);
    expect(json<TicketView>(t('add', 'Low', '--priority', 'P5')).priority).toBe('P5');
    expect(json<TicketView>(t('add', 'Top', '--priority', 'p0')).priority).toBe('P0');
    expect(json<TicketView>(t('add', 'Mid', '--priority', 'P4')).id).toBe(3);
    for (const bad of ['P6', 'P-1']) {
      const r = t('add', 'Bad', '--priority', bad);
      expect(r.code).toBe(1);
      expect(r.err).toContain('priority must be one of P0, P1, P2, P3, P4, P5');
    }
    expect(json<TicketList>(t('order')).tickets.map((x) => x.id)).toEqual([2, 3, 1]);
    expect(json<TicketList>(t('list', '--priority', 'P0')).tickets.map((x) => x.id)).toEqual([2]);
    expect(t('list', '--priority', 'P6').code).toBe(1);
    expect(json<TicketView>(t('edit', '3', '--priority', 'P0')).priority).toBe('P0');
    expect(json<TicketView>(t('edit', '2', '--priority', 'P5')).priority).toBe('P5');
    expect(json<{ type: string; payload: unknown }[]>(t('history', '2')).at(-1)).toMatchObject({
      type: 'ticket.priority-changed',
      payload: { from: 'P0', to: 'P5' },
    });
    expect(orch(h, outside, ['ticket', '--help']).out).toContain('--priority P0|P1|P2|P3|P4|P5');
  });
});
