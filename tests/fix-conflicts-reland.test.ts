/**
 * GitHub's `mergeable` answer recorded on pr.observed / ci.observed backs Fix merge conflicts, and
 * a completed job whose open PR is CONFLICTING is re-landed: a new job, the old one superseded.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { prStatus } from '../src/ops/github.ts';
import { detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import { addTicket, showTicket, ticketAction } from '../src/ops/tickets.ts';
import { getJob, linkJobToTicket, listJobs } from '../src/storage/jobs.ts';
import { type Ctx, head, start, toCi } from './drive.ts';
import { checks, clone, job, reconcile, run, shim, store } from './ci-fixture.ts';

const editPr = (patch: Record<string, unknown>) => {
  const st = shim.read();
  st.prs[0] = { ...st.prs[0], ...patch };
  shim.write({ prs: st.prs });
};
const payloads = (c: Ctx, type: string) =>
  listEvents(store.db, c.id, 1000)
    .filter((e) => e.type === type)
    .map((e) => e.payload);
const offered = (c: Ctx) => detail(store, c.id).actions.includes('fix-conflicts');

describe('fix-conflicts from GitHub CONFLICTING, and the completed re-land', () => {
  it('a recorded CONFLICTING shows the action with no local conflict; a newer answer hides it', () => {
    const c = start(store, clone);
    toCi(store, c);
    expect(offered(c)).toBe(false);
    editPr({ mergeable: 'CONFLICTING' });
    prStatus(store, c.id, { token: c.token });
    expect(payloads(c, 'ci.observed').at(-1)).toMatchObject({ mergeable: 'CONFLICTING' });
    expect(detail(store, c.id).conflicts).toEqual({ files: [], github: true });
    expect(offered(c)).toBe(true);
    editPr({ mergeable: 'MERGEABLE' });
    reconcile(c);
    expect(payloads(c, 'ci.observed').at(-1)).toMatchObject({ mergeable: 'MERGEABLE' });
    expect(offered(c)).toBe(false);
  });

  it('a completed job with a CONFLICTING open PR is re-landed once; other answers create nothing', () => {
    const c = start(store, clone);
    toCi(store, c);
    checks(head(c.wt), [run('test', 'success')]);
    expect(reconcile(c).action).toBe('complete');
    const done = job(c);
    expect(done).toMatchObject({ status: 'completed', prState: 'ready' });
    expect(offered(c)).toBe(false);
    editPr({ mergeable: 'CONFLICTING' });
    dashboardAction(store, c.id, { action: 'refresh-pr', force: true });
    expect(payloads(c, 'pr.observed').at(-1)).toMatchObject({ mergeable: 'CONFLICTING' });
    expect(offered(c)).toBe(true);

    // GitHub is re-read on the click: anything but OPEN and CONFLICTING creates no job.
    const count = listJobs(store.db).length;
    for (const patch of [
      { mergeable: 'MERGEABLE' },
      { mergeable: 'UNKNOWN' },
      { state: 'CLOSED' },
    ]) {
      editPr({ state: 'OPEN', mergeable: 'CONFLICTING', ...patch });
      expect(() => dashboardAction(store, c.id, { action: 'fix-conflicts', force: true })).toThrow(
        ValidationError,
      );
      expect(listJobs(store.db)).toHaveLength(count);
      expect(job(c).supersededBy).toBeNull();
      // Put the recorded answer back so the next case still reaches GitHub.
      editPr({ state: 'OPEN', mergeable: 'CONFLICTING' });
      dashboardAction(store, c.id, { action: 'refresh-pr', force: true });
    }

    // The finished job worked on a ticket: its re-land works on the same one.
    const ticket = addTicket(store, { title: 'CSV export', repo: clone });
    ticketAction(store, ticket.id, { action: 'start' });
    expect(linkJobToTicket(store.db, c.id, ticket.id)).toBe(true);

    const r = dashboardAction(store, c.id, { action: 'fix-conflicts', force: true });
    const jobs = listJobs(store.db);
    expect(jobs).toHaveLength(count + 1);
    const next = jobs.find((j) => j.id !== c.id && j.supersededBy === null);
    if (!next) throw new Error('no re-land job');
    expect(next.ticketId).toBe(ticket.id);
    expect(showTicket(store, ticket.id)).toMatchObject({
      ticket: { status: 'in-progress', activeJob: next.id },
      jobs: [{ id: c.id }, { id: next.id }],
    });
    expect(next).toMatchObject({
      title: `${done.title} (re-land)`,
      stage: 'spec',
      status: 'pending',
      ownerSession: null,
      worktreePath: null,
    });
    expect(next.description).toContain('Test request');
    expect(next.description).toContain(`Re-land the work of ${c.id} (PR ${String(done.prUrl)}`);
    expect(next.description).toContain(`branch ${String(done.branch)}`);
    expect(job(c)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      supersededBy: next.id,
    });
    expect(r.message).toContain(next.id);
    expect(r.message).toContain(`/factory ${next.id}`);
    expect(r.message).toContain(`gh pr close ${String(done.prUrl)}`);
    expect(r.resumeCommand).toBe(`/factory ${next.id}`);
    expect(listEvents(store.db, next.id, 1000).map((e) => e.type)).not.toContain(
      'session.attached',
    );

    // Superseded: refused before anything is read or written.
    const before = getJob(store.db, c.id);
    expect(offered(c)).toBe(false);
    expect(() => dashboardAction(store, c.id, { action: 'fix-conflicts', force: true })).toThrow(
      ValidationError,
    );
    expect(getJob(store.db, c.id)).toEqual(before);
    expect(listJobs(store.db)).toHaveLength(count + 1);
  });
});
