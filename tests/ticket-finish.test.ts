/**
 * Finishing a merged ticket whose boxes are not all ticked (ticket 0218): the pure box helpers,
 * `splitTicket`, `done` with `tickAll`, and the `finish` view of `showTicket`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError, WorkflowError } from '../src/core/errors.ts';
import { jobArtifactDir } from '../src/core/paths.ts';
import { markdownSection, pickBoxes, tickBoxes } from '../src/core/tickets.ts';
import {
  addTicket,
  finishLines,
  listTickets,
  showTicket,
  ticketAction,
  ticketHistory,
} from '../src/ops/tickets.ts';
import { createJob } from '../src/storage/jobs.ts';
import { artifacts, jobs } from '../src/storage/schema.ts';
import { allTickets, splitTicket, ticketLifecycle } from '../src/storage/tickets.ts';
import { makeRepo, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let alpha: string;
let beta: string;

beforeAll(() => {
  store = tempStore();
  alpha = makeRepo('git@github.com:acme/alpha.git');
  beta = makeRepo('git@github.com:acme/beta.git');
});
afterAll(() => {
  store.cleanup();
});

const PR = 'https://github.com/acme/alpha/pull/7';
const BODY = '## Done when\n\n- [ ] one\n- [x] already\n- [ ] two\n* [ ] three\n';

/** An in-progress ticket whose only job completed with a merged PR. */
function merged(title: string, extra: Record<string, unknown> = {}) {
  const t = addTicket(store, {
    title,
    repo: alpha,
    area: 'web',
    priority: 'P1',
    body: BODY,
    ...extra,
  });
  const job = createJob(store, {
    title: 'j',
    description: 'd',
    repo: t.repo,
    repoPath: alpha,
    baseBranch: 'main',
    ticketId: t.id,
  });
  store.db
    .update(jobs)
    .set({ stage: 'completed', status: 'completed', prUrl: PR, prState: 'merged' })
    .where(eq(jobs.id, job.id))
    .run();
  return { id: t.id, jobId: job.id, before: showTicket(store, t.id).ticket };
}
const count = () => allTickets(store.db).length;

describe('box helpers', () => {
  it('number the unticked boxes in order and tick only the chosen ones', () => {
    expect(pickBoxes(BODY)).toEqual({ numbers: [1, 2, 3], items: ['one', 'two', 'three'] });
    expect(pickBoxes(BODY, [3, 1, 3])).toEqual({ numbers: [1, 3], items: ['one', 'three'] });
    for (const bad of [[0], [4], [1.5], []]) {
      expect(() => pickBoxes(BODY, bad)).toThrow(ValidationError);
    }
    expect(() => pickBoxes('- [x] a\n')).toThrow(/no unticked box/);
    expect(tickBoxes('- [ ] a  \r\n- [ ] a\r\n1. [ ] b\r\n', [2, 3], ' (moved to 0009)')).toBe(
      '- [ ] a  \r\n- [x] a (moved to 0009)\r\n1. [x] b (moved to 0009)\r\n',
    );
    expect(tickBoxes(BODY, 'all')).toBe(
      '## Done when\n\n- [x] one\n- [x] already\n- [x] two\n* [x] three\n',
    );
  });

  it('markdownSection reads one section and nothing else', () => {
    const md = '# Build\n\n## Known gaps\n\n- none tested on mac\n\n## Validation\nrun 1\n';
    expect(markdownSection(md, 'Known gaps')).toBe('- none tested on mac');
    expect(markdownSection(md.replace(/\n/g, '\r\n'), 'Validation')).toBe('run 1');
    expect(markdownSection(md, 'Summary')).toBeNull();
    expect(markdownSection('## Known gaps\n\n## Next\n', 'Known gaps')).toBeNull();
  });
});

describe('splitTicket', () => {
  it('moves the chosen boxes to a follow-up, marks them on the original, and closes it (AC1)', () => {
    const t = merged('Export CSV');
    const { ticket, followUp } = splitTicket(store, t.id, {
      boxes: [1, 3],
      expectRevision: t.before.revision,
      actor: 'me',
    });
    expect(followUp).toMatchObject({
      title: 'Follow-up of 0001: Export CSV',
      status: 'open',
      type: 'feature',
      repo: t.before.repo,
      repoPath: alpha,
      area: 'web',
      priority: 'P1',
      related: [t.id],
    });
    expect(followUp.body).toContain(`ticket 0001 (Export CSV), merged as ${PR}`);
    expect(followUp.body.match(/^- \[ \] .*$/gm)).toEqual(['- [ ] one', '- [ ] three']);
    const key = String(followUp.id).padStart(4, '0');
    expect(ticket.status).toBe('done');
    expect(ticket.body).toBe(
      `## Done when\n\n- [x] one (moved to ${key})\n- [x] already\n- [ ] two\n* [x] three (moved to ${key})\n`,
    );
    expect(ticket.revision).toBe(t.before.revision + 1);
    const last = ticketHistory(store, t.id).at(-1);
    expect(last).toMatchObject({
      type: 'ticket.completed',
      actor: 'me',
      payload: { from: 'in-progress', to: 'done', followUp: followUp.id, prUrl: PR },
    });
    expect(last?.payload['note']).toBe(
      `merged ${PR}; 2 unticked box(es) moved to follow-up ${key}`,
    );
    expect(ticketHistory(store, followUp.id).map((e) => e.type)).toEqual(['ticket.created']);
  });

  it('with hold files a question no controller picks up; without boxes moves every one (AC2)', () => {
    const t = merged('Held');
    const view = ticketAction(store, t.id, {
      action: 'split',
      hold: true,
      repo: beta,
      area: 'docs',
      priority: 'p4',
      note: 'ask Sam',
      revision: t.before.revision,
    });
    expect(view).toMatchObject({ status: 'done' });
    const followUp = showTicket(store, view.followUp ?? 0).ticket;
    expect(followUp).toMatchObject({
      type: 'question',
      repoPath: beta,
      area: 'docs',
      priority: 'P4',
      ready: false,
    });
    expect(followUp.body.match(/^- \[ \] /gm)).toHaveLength(3);
    expect(listTickets(store, { view: 'ready' }).tickets.map((x) => x.id)).not.toContain(
      followUp.id,
    );
    expect(ticketHistory(store, t.id).at(-1)?.payload['note']).toMatch(/^ask Sam; merged /);
  });

  it('is all or nothing: a refusal leaves no new ticket and the original untouched (AC3)', () => {
    const t = merged('Refused');
    const n = count();
    const same = () => {
      expect(count()).toBe(n);
      expect(showTicket(store, t.id).ticket).toEqual(t.before);
    };
    expect(() => splitTicket(store, t.id, { expectRevision: t.before.revision - 1 })).toThrow(
      OwnershipError,
    );
    same();
    expect(() => splitTicket(store, t.id, { area: 'no-such-area' })).toThrow(ValidationError);
    same();
    expect(() => splitTicket(store, t.id, { boxes: [4] })).toThrow(/boxes must name/);
    same();
    expect(() => ticketAction(store, t.id, { action: 'split', boxes: 'x' })).toThrow(
      ValidationError,
    );
    same();

    const busy = addTicket(store, { title: 'Busy', repo: alpha, body: BODY });
    createJob(store, {
      title: 'j',
      description: 'd',
      repo: busy.repo,
      repoPath: alpha,
      baseBranch: 'main',
      ticketId: busy.id,
    });
    const before = showTicket(store, busy.id).ticket;
    const m = count();
    expect(() => splitTicket(store, busy.id)).toThrow(WorkflowError);
    expect(count()).toBe(m);
    expect(showTicket(store, busy.id).ticket).toEqual(before);

    // A closed ticket, and one with nothing unticked, are refused too.
    const closed = addTicket(store, { title: 'Closed', repo: alpha, body: BODY });
    ticketAction(store, closed.id, { action: 'drop' });
    expect(() => splitTicket(store, closed.id)).toThrow(WorkflowError);
    const ticked = addTicket(store, { title: 'Ticked', repo: alpha, body: '- [x] a\n' });
    expect(() => splitTicket(store, ticked.id)).toThrow(/no unticked box/);
    expect(count()).toBe(m + 2);
  });
});

describe('done with tickAll', () => {
  it('ticks every box and closes in one write; a stale revision changes nothing (AC4)', () => {
    const t = merged('Close me');
    expect(() =>
      ticketLifecycle(store, t.id, 'done', {
        tickAll: true,
        expectRevision: t.before.revision + 5,
      }),
    ).toThrow(OwnershipError);
    expect(showTicket(store, t.id).ticket).toEqual(t.before);
    expect(() => ticketAction(store, t.id, { action: 'drop', tickAll: true })).toThrow(
      /tickAll goes with done only/,
    );
    expect(showTicket(store, t.id).ticket).toEqual(t.before);

    const done = ticketAction(store, t.id, {
      action: 'done',
      tickAll: true,
      revision: t.before.revision,
    });
    expect(done).toMatchObject({ status: 'done', revision: t.before.revision + 1 });
    expect(done.body).toBe('## Done when\n\n- [x] one\n- [x] already\n- [x] two\n* [x] three\n');
    expect(ticketHistory(store, t.id).at(-1)?.type).toBe('ticket.completed');
  });
});

describe('finish view', () => {
  it('is set only for an in-progress ticket whose newest job merged with boxes left', () => {
    const t = merged('Needs a person');
    expect(showTicket(store, t.id).finish).toEqual({
      jobId: t.jobId,
      prUrl: PR,
      remaining: ['one', 'two', 'three'],
      knownGaps: null,
    });

    // Known gaps come from the registered build.md only.
    const dir = jobArtifactDir(t.jobId, store.paths);
    mkdirSync(dir, { recursive: true });
    const build = '# Build\n\n## Known gaps\n\nnot run on Windows\n\n## Validation\nok\n';
    writeFileSync(join(dir, 'build.md'), build);
    expect(showTicket(store, t.id).finish?.knownGaps).toBeNull();
    const row = { jobId: t.jobId, stage: 'build' as const, path: 'build.md', bytes: build.length };
    store.db
      .insert(artifacts)
      .values({ ...row, createdAt: new Date().toISOString() })
      .run();
    expect(showTicket(store, t.id).finish?.knownGaps).toBe('not run on Windows');

    // Rework: back to open, nothing left to finish here.
    expect(ticketAction(store, t.id, { action: 'reopen', note: 'rework' }).status).toBe('open');
    expect(showTicket(store, t.id).finish).toBeNull();

    const open = addTicket(store, { title: 'Open', repo: alpha, body: BODY });
    expect(showTicket(store, open.id).finish).toBeNull();
    createJob(store, {
      title: 'j',
      description: 'd',
      repo: open.repo,
      repoPath: alpha,
      baseBranch: 'main',
      ticketId: open.id,
    });
    expect(showTicket(store, open.id).finish).toBeNull();
    const none = merged('No boxes', { body: '- [x] a\n' });
    expect(showTicket(store, none.id).finish).toBeNull();
    const closed = merged('Closed');
    ticketAction(store, closed.id, { action: 'done', tickAll: true });
    expect(showTicket(store, closed.id).finish).toBeNull();
  });

  it('finishLines gives one confirm link and one command per option', () => {
    expect(finishLines(218)).toEqual([
      'Move to a follow-up and close: http://127.0.0.1:4777/#/tickets/0218?finish=split (or orch ticket split 0218)',
      'They are done, close: http://127.0.0.1:4777/#/tickets/0218?finish=close (or orch ticket done 0218 --tick-all)',
      'Rework: http://127.0.0.1:4777/#/tickets/0218?finish=rework (or orch ticket reopen 0218)',
    ]);
  });
});
