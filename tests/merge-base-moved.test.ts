/**
 * Merge only when the verified head contains the current base (decision
 * 2026-11-24-merge-requires-current-base): GitHub's compare says the base moved after CI passed, so
 * `mergeJob` merges the base into the branch, reopens the completed job into pr, and merges only
 * at the new head once CI passed there. A conflict re-lands, and a disagreement between GitHub and
 * origin or a sibling job on the ticket leaves the job completed. Uses tests/ci-fixture.ts.
 */
import { describe, expect, it } from 'vitest';

import { WorkflowError } from '../src/core/errors.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { resumeFactoryJob } from '../src/ops/factory.ts';
import { mergeJob, setMergeAuthorization } from '../src/ops/merge.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob, reopenJob } from '../src/storage/jobs.ts';
import { listIntegrations } from '../src/storage/verification.ts';
import { checks, clone, job, reconcile, run, shim, store } from './ci-fixture.ts';
import { type Ctx, deliverPr, fastBuild, go, head, SESSION, startFast, verify } from './drive.ts';
import { commitFile, gitIn } from './helpers.ts';

const reopened = (c: Ctx) =>
  listEvents(store.db, c.id, 1000).filter((e) => e.type === 'job.reopened');
const merge = (c: Ctx) => mergeJob(store, c.id, { session: 'merger' });
const merges = () => shim.read().calls.filter((x) => x[0] === 'pr' && x[1] === 'merge');

/** GitHub's compare answer for `main...<sha>`. */
const behind = (sha: string, by: number) => {
  shim.write({ api: { [`repos/acme/alpha/compare/main...${sha}`]: { behind_by: by } } });
};

/** Advance main on origin with a commit to `file`. */
function advanceBase(file: string, body = 'upstream\n'): string {
  const sha = commitFile(clone, file, body, `base: ${file}`);
  gitIn(clone, 'push', '-q', 'origin', 'main');
  return sha;
}

/** A fast job on a new ticket, delivered and completed on a passing verdict at H1. */
function completed(): { c: Ctx; h1: string; ticketId: number } {
  setMergeAuthorization(store, clone, true);
  const ticketId = addTicket(store, { title: 'Export CSV', repo: clone }).id;
  const c = startFast(store, clone, ticketId);
  fastBuild(store, c);
  go(store, c, 'start');
  deliverPr(store, c);
  go(store, c, 'start');
  const h1 = head(c.wt);
  checks(h1, [run('test', 'success')]);
  expect(reconcile(c)).toMatchObject({ action: 'complete' });
  expect(job(c).stage).toBe('completed');
  return { c, h1, ticketId };
}

describe('merge when the base moved after CI passed', () => {
  it('merges the base in, reopens into pr, and merges only at the new verified head', () => {
    const { c, h1, ticketId } = completed();
    const tip = advanceBase('docs/notes.md');
    behind(h1, 1);

    const r = merge(c);
    expect(r).toMatchObject({ outcome: 'base-moved', code: null });
    expect(merges()).toHaveLength(0);
    expect(job(c)).toMatchObject({ stage: 'pr', status: 'pending', completedAt: null });
    expect(reopened(c)).toHaveLength(1);
    const [newest] = listIntegrations(store.db, c.id);
    expect(newest).toMatchObject({ status: 'merged', fromHead: h1, baseSha: tip });
    const h2 = head(c.wt);
    expect(newest?.resultHead).toBe(h2);
    expect(gitIn(c.wt, 'rev-list', '--parents', '-n', '1', h2).split(' ')).toEqual([h2, h1, tip]);
    expect(reopened(c)[0]?.payload).toMatchObject({ fromHead: h1, mergeHead: h2, baseSha: tip });
    expect(r.reason).toContain(h2.slice(0, 7));

    // The ordinary pr and ci stages, as /factory runs them.
    c.token = resumeFactoryJob(store, c.id, { session: SESSION }).token;
    go(store, c, 'start');
    verify(store, c);
    deliverPr(store, c);
    go(store, c, 'start');
    checks(h2, [run('test', 'success')]);
    expect(reconcile(c)).toMatchObject({ action: 'complete' });
    expect(job(c)).toMatchObject({ stage: 'completed', ciHead: h2 });

    behind(h2, 0);
    expect(merge(c)).toMatchObject({ outcome: 'merged', verified: true, prHead: h2 });
    expect(merges().at(-1)).toContain(h2);
    expect(showTicket(store, ticketId).ticket.status).toBe('done');
  });

  it('a moved base GitHub also reports CONFLICTING re-lands without a reopen', () => {
    const { c, h1 } = completed();
    behind(h1, 1);
    const st = shim.read();
    shim.write({ prs: st.prs.map((p) => ({ ...p, mergeable: 'CONFLICTING' })) });
    const r = merge(c);
    expect(r.outcome).toBe('reland');
    expect(r.relandJob).not.toBeNull();
    expect(reopened(c)).toHaveLength(0);
    expect(job(c).stage).toBe('completed');
  });

  it('GitHub says behind while origin is up to date: error, the job stays completed', () => {
    const { c, h1 } = completed();
    behind(h1, 1);
    const r = merge(c);
    expect(r.outcome).toBe('error');
    expect(r.reason).toMatch(/GitHub and origin disagree/);
    expect(job(c)).toMatchObject({ stage: 'completed', status: 'completed' });
    expect(reopened(c)).toHaveLength(0);
    expect(merges()).toHaveLength(0);
  });

  it('a sibling unfinished job on the ticket: reopen-refused, nothing integrated', () => {
    const { c, h1, ticketId } = completed();
    advanceBase('docs/notes.md');
    behind(h1, 1);
    const sibling = createJob(store, {
      title: 'Another try',
      description: 'Request',
      repo: job(c).repo,
      repoPath: clone,
      baseBranch: 'main',
      ticketId,
    });
    const before = listIntegrations(store.db, c.id).length;
    const r = merge(c);
    expect(r).toMatchObject({ outcome: 'blocked', code: 'reopen-refused' });
    expect(r.reason).toContain(sibling.id);
    expect(job(c)).toMatchObject({ stage: 'completed', status: 'completed' });
    expect(listIntegrations(store.db, c.id)).toHaveLength(before);
    expect(reopened(c)).toHaveLength(0);
    // The storage function refuses it too, in its own transaction, never as a SQLite error.
    const { token } = claimJob(store, c.id, { session: 'merger' });
    const ctx = { reason: 'main moved', mergeHead: h1, baseSha: h1 };
    expect(() => reopenJob(store, c.id, { token }, ctx)).toThrow(WorkflowError);
    expect(() => reopenJob(store, c.id, { token }, ctx)).toThrow(sibling.id);
  });

  it("the dashboard's Merge returns a message and leaves the job in pr", () => {
    const { c, h1 } = completed();
    advanceBase('docs/notes.md');
    behind(h1, 1);
    const r = dashboardAction(store, c.id, { action: 'merge' });
    expect(r.message).toMatch(/merge commit [0-9a-f]{7}/);
    expect(r.message).toContain(`/factory ${c.id}`);
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'pr', status: 'pending' });
    expect(merges()).toHaveLength(0);
  });
});
