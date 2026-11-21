/** Tickets and jobs: explicit association, one unfinished job per ticket, no premature completion. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationError, WorkflowError } from '../src/core/errors.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { startJob } from '../src/ops/factory.ts';
import {
  addTicket,
  jobsOfTicket,
  listTickets,
  showTicket,
  ticketAction,
  ticketHistory,
} from '../src/ops/tickets.ts';
import { claimJob, createJob, getJob, listJobs, transitionJob } from '../src/storage/jobs.ts';
import { jobs as jobsTable } from '../src/storage/schema.ts';
import { gitIn, makeRepoWithOrigin, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let alpha: string;
let beta: string;

beforeAll(() => {
  store = tempStore();
  alpha = makeRepoWithOrigin('git@github.com:acme/alpha.git').clone;
  beta = makeRepoWithOrigin('git@github.com:acme/beta.git').clone;
});
afterAll(() => {
  store.cleanup();
});

const add = (title: string, extra: Record<string, unknown> = {}, repo = alpha) =>
  addTicket(store, { title, repo, ...extra });
const dispatch = (ticket: number, over: Record<string, unknown> = {}) =>
  dispatchJob(store, { ticket, session: 's', cwd: tempDir(), ...over }).job;
const cancel = (jobId: string) => {
  const { token } = claimJob(store, jobId, { session: 's', force: true });
  transitionJob(store, jobId, 'cancel', { token, reason: 'test' });
};

describe('a job for a ticket', () => {
  it('is created in the ticket repository, linked, and marks the ticket in progress at once', () => {
    const t = add('Fix the race', { body: '## What\n\n- [ ] fix it' }, beta);
    // No --repo and a cwd elsewhere: the ticket says where the work is.
    const job = dispatch(t.id);
    expect(job).toMatchObject({
      ticketId: t.id,
      repo: 'github.com/acme/beta',
      repoPath: beta,
      title: 'Ticket 0001: Fix the race',
      issueRef: null,
    });
    expect(job.description).toBe('Ticket 0001 (Fix the race).\n\n## What\n\n- [ ] fix it');
    const d = showTicket(store, t.id);
    expect(d.ticket).toMatchObject({ status: 'in-progress', activeJob: job.id });
    expect(d.jobs).toMatchObject([{ id: job.id, status: 'pending' }]);
    expect(ticketHistory(store, t.id).map((e) => e.type)).toEqual([
      'ticket.created',
      'ticket.started',
      'ticket.job-linked',
    ]);
  });

  it('refuses a second unfinished job, by rule and by the database constraint', () => {
    const t = add('One at a time');
    const first = dispatch(t.id, { title: 'First', description: 'd' });
    const count = listJobs(store.db).length;
    expect(() => dispatch(t.id)).toThrow(new RegExp(`job ${first.id} is already working on it`));
    expect(listJobs(store.db)).toHaveLength(count);
    // Underneath the rule: the partial unique index refuses the row itself.
    let refused: unknown;
    try {
      const copy = { ...getJob(store.db, first.id), id: 'job-ffffffff' };
      store.db.insert(jobsTable).values(copy).run();
    } catch (err) {
      refused = (err as Error).cause;
    }
    expect(String(refused)).toMatch(/UNIQUE constraint failed: jobs\.ticketId/);
    // A ticket with an unfinished job is not offered again and cannot be closed under it.
    expect(listTickets(store, { view: 'ready' }).tickets.map((x) => x.id)).not.toContain(t.id);
    for (const action of ['done', 'drop']) {
      expect(() => ticketAction(store, t.id, { action })).toThrow(/still working on ticket/);
    }
  });

  it('many jobs over time: a finished attempt frees the ticket, and finishing never closes it', () => {
    const t = add('Retry me');
    const first = dispatch(t.id);
    cancel(first.id);
    // Cancelled or completed, the job leaves the ticket in progress: closing is explicit.
    expect(showTicket(store, t.id).ticket).toMatchObject({
      status: 'in-progress',
      activeJob: null,
    });
    const second = dispatch(t.id, {
      title: 'Ticket 0003: Retry me (re-land)',
      description: 'again',
    });
    expect(second.ticketId).toBe(t.id);
    expect(jobsOfTicket(store, t.id).map((j) => [j.id, j.status])).toEqual([
      [first.id, 'cancelled'],
      [second.id, 'pending'],
    ]);
    cancel(second.id);
    expect(ticketAction(store, t.id, { action: 'done', note: 'merged' }).status).toBe('done');
    expect(() => dispatch(t.id)).toThrow(/is done; only an open or in-progress ticket/);
  });

  it('is refused, creating nothing, while the ticket is blocked, a question, or elsewhere', () => {
    const dep = add('Dependency');
    const blocked = add('Blocked', { dependsOn: [dep.id] });
    const question = add('Decide', { type: 'question' });
    const count = listJobs(store.db).length;
    expect(() => dispatch(blocked.id)).toThrow(/depends on 000\d, which is open/);
    expect(() => dispatch(question.id)).toThrow(/a decision to make/);
    expect(() => dispatch(999)).toThrow(/No ticket 0999/);
    // The ticket belongs to alpha: a job for it cannot be created in beta.
    expect(() => dispatch(dep.id, { repo: beta })).toThrow(ValidationError);
    expect(() => startJob(store, { ticket: dep.id, session: 's', cwd: beta })).toThrow(
      /belongs to github.com\/acme\/alpha/,
    );
    // Nor from a directory that is no repository at all: the ticket names where to go.
    expect(() => startJob(store, { ticket: dep.id, session: 's', cwd: tempDir() })).toThrow(
      /belongs to github.com\/acme\/alpha \(.*\); .* is not inside a Git repository\. Run from that repository/,
    );
    expect(listJobs(store.db)).toHaveLength(count);
    for (const id of [blocked.id, question.id, dep.id]) {
      expect(showTicket(store, id).ticket).toMatchObject({ status: 'open', revision: 1 });
    }
  });

  it('a failed job insert rolls the claim back', () => {
    const t = add('Atomic');
    expect(() =>
      createJob(store, {
        title: 'x',
        description: 'd',
        repo: 'r',
        repoPath: alpha,
        baseBranch: null as unknown as string, // NOT NULL: the insert fails after the claim
        ticketId: t.id,
      }),
    ).toThrow();
    expect(showTicket(store, t.id).ticket).toMatchObject({
      status: 'open',
      revision: 1,
      activeJob: null,
    });
    expect(ticketHistory(store, t.id)).toHaveLength(1);
  });

  it('orch factory start --ticket claims from a worktree of the ticket repository', () => {
    const t = add('Start here');
    const wt = `${tempDir('orch-wt-')}/wt`;
    gitIn(alpha, 'worktree', 'add', '-q', '-b', 'session', wt);
    const started = startJob(store, { ticket: String(t.id), session: 'child', cwd: wt });
    expect(started.job).toMatchObject({
      ticketId: t.id,
      repoPath: alpha,
      title: `Ticket ${t.key}: Start here`,
    });
    expect(showTicket(store, t.id).ticket).toMatchObject({
      status: 'in-progress',
      activeJob: started.job.id,
    });
    expect(() => startJob(store, { ticket: t.id, session: 'other', cwd: alpha })).toThrow(
      WorkflowError,
    );
  });

  it('jobs without a ticket, and GitHub issue references, work as before', () => {
    const plain = dispatchJob(store, {
      repo: alpha,
      title: 'Plain',
      description: 'd',
      session: 's',
      cwd: alpha,
    });
    expect(plain.job.ticketId).toBeNull();
    const first = dispatchJob(store, {
      repo: alpha,
      title: 'I',
      description: 'd',
      issue: '45',
      session: 's',
      cwd: alpha,
    });
    expect(first.job).toMatchObject({ issueRef: '#45', ticketId: null });
    // Issue de-duplication is untouched: the same issue returns the same job.
    const again = dispatchJob(store, {
      repo: alpha,
      title: 'I',
      description: 'd',
      issue: '#45',
      session: 's',
      cwd: alpha,
    });
    expect(again).toMatchObject({ duplicate: true, job: { id: first.job.id } });
  });
});
