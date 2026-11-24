/**
 * `mergeJob`, the operation behind `orch job merge` and the dashboard's Merge: eligibility from
 * fresh GitHub state, the exact-head merge commit, GitHub-confirmed evidence, ticket completion,
 * the bounded re-land, retries after interruption, and the per-repository opt-in. Jobs are put in
 * their completed state directly (tests/pr-merge.test.ts drives a real one through the dashboard).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { uncheckedItems } from '../src/core/tickets.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import {
  mergeAuthorization,
  mergeAuthorized,
  mergeJob,
  type MergeResult,
  relandJob,
  setMergeAuthorization,
} from '../src/ops/merge.ts';
import { addTicket, showTicket, ticketAction, ticketHistory } from '../src/ops/tickets.ts';
import { detail } from '../src/server/api.ts';
import { appendEvent, listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob, listJobs } from '../src/storage/jobs.ts';
import { type Job, jobs } from '../src/storage/schema.ts';
import { makePolicyRepo } from './drive.ts';
import {
  commitFile,
  type GhShim,
  ghShim,
  gitIn,
  json,
  makeRepo,
  orch,
  type TempStore,
  tempStore,
} from './helpers.ts';

const REPO = 'github.com/acme/alpha';
/** The verified head: a real commit (the clone's main), so local Git sees no change at all. */
let SHA = '';
const OTHER = 'b'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);

let store: TempStore;
let clone: string;
let bare: string;
let shim: GhShim;
let n = 0;

beforeAll(() => {
  shim = ghShim('acme/alpha');
  Object.assign(process.env, shim.env);
  ({ clone, bare } = makePolicyRepo());
  SHA = gitIn(clone, 'rev-parse', 'HEAD');
});
afterAll(() => {
  delete process.env['ORCH_GH_SHIM'];
  delete process.env['ORCH_GH_SHIM_STATE'];
  shim.cleanup();
  for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  shim.reset();
  store = tempStore();
  n = 0;
  // Most tests are about the gates behind the opt-in; the ones about the opt-in turn it off.
  setMergeAuthorization(store, clone, true);
});
afterEach(() => {
  store.cleanup();
});

const prUrl = (num: number) => `https://github.com/acme/alpha/pull/${String(num)}`;

/** Put a job in the state `orch gh ci` leaves it in, with its open PR on GitHub. */
function finish(job: Job, over: Partial<Job> = {}, completion?: Record<string, unknown>): Job {
  n += 1;
  const url = prUrl(n);
  const branch = `factory/${job.id}`;
  const ts = new Date().toISOString();
  store.db
    .update(jobs)
    .set({
      stage: 'completed',
      status: 'completed',
      branch,
      prUrl: url,
      prState: 'ready',
      ciStatus: 'passing',
      ciHead: SHA,
      completedAt: ts,
      ...over,
    })
    .where(eq(jobs.id, job.id))
    .run();
  appendEvent(store.db, job.id, 'job.completed', completion ?? { prUrl: url, head: SHA }, null, ts);
  shim.write({
    prs: [
      ...shim.read().prs,
      {
        number: n,
        url,
        state: 'OPEN',
        isDraft: false,
        baseRefName: 'main',
        headRefName: branch,
        headRefOid: SHA,
        mergeable: 'MERGEABLE',
        title: job.title,
        statusCheckRollup: [],
        isCrossRepository: false,
      },
    ],
  });
  return getJob(store.db, job.id);
}

function completed(
  o: { ticket?: number; job?: Partial<Job>; completion?: Record<string, unknown> } = {},
): Job {
  const job = createJob(store, {
    title: 'Add CSV export',
    description: 'Request',
    repo: REPO,
    repoPath: clone,
    baseBranch: 'main',
    ticketId: o.ticket,
  });
  return finish(job, o.job, o.completion);
}

const editPr = (job: Job, patch: Record<string, unknown>) => {
  shim.write({
    prs: shim.read().prs.map((p) => (p['url'] === job.prUrl ? { ...p, ...patch } : p)),
  });
};
const githubMerged = (job: Job, head = SHA) => {
  editPr(job, { state: 'MERGED', headRefOid: head, mergeCommit: { oid: MERGE_COMMIT } });
};
const merge = (job: Job, session = 'merger'): MergeResult => mergeJob(store, job.id, { session });
const merges = () => shim.read().calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');
const events = (job: Job, type?: string) =>
  listEvents(store.db, job.id, 1000).filter((e) => type === undefined || e.type === type);
const ticket = (body = '') => addTicket(store, { title: 'Export CSV', repo: clone, body }).id;
const ticketEvents = (id: number, type: string) =>
  ticketHistory(store, id).filter((e) => e.type === type);
const status = (id: number) => showTicket(store, id).ticket.status;

describe('refusals: nothing is merged, written, or claimed', () => {
  const cases: [string, MergeResult['code'], () => Job][] = [
    [
      'a job still in ci',
      'not-completed',
      () => completed({ job: { stage: 'ci', status: 'running' } }),
    ],
    [
      'a human close-out',
      'wrong-completion',
      () => completed({ completion: { head: SHA, acceptedByHuman: true } }),
    ],
    ['a failing verdict', 'no-ci-evidence', () => completed({ job: { ciStatus: 'failing' } })],
    ['no verified head', 'no-ci-evidence', () => completed({ job: { ciHead: null } })],
    ['no PR', 'no-pr', () => completed({ job: { prUrl: null } })],
    [
      'a draft PR',
      'pr-draft',
      () => {
        const j = completed();
        editPr(j, { isDraft: true });
        return j;
      },
    ],
    [
      'a closed PR',
      'pr-closed',
      () => {
        const j = completed();
        editPr(j, { state: 'CLOSED' });
        return j;
      },
    ],
    [
      'a head pushed after the verdict',
      'head-changed',
      () => {
        const j = completed();
        editPr(j, { headRefOid: OTHER });
        return j;
      },
    ],
    [
      'a PR into another base',
      'wrong-base',
      () => {
        const j = completed();
        editPr(j, { baseRefName: 'develop' });
        return j;
      },
    ],
    [
      'a PR from another branch',
      'wrong-head-branch',
      () => {
        const j = completed();
        editPr(j, { headRefName: 'someone/else' });
        return j;
      },
    ],
    [
      'a PR from a fork',
      'wrong-head-branch',
      () => {
        const j = completed();
        editPr(j, { isCrossRepository: true });
        return j;
      },
    ],
    [
      'a PR of another repository',
      'wrong-repository',
      () => completed({ job: { repo: 'github.com/acme/beta' } }),
    ],
    [
      'a repository that is not opted in',
      'not-authorized',
      () => {
        setMergeAuthorization(store, clone, false);
        return completed();
      },
    ],
  ];
  it.each(cases)('%s is blocked as %s', (_name, code, make) => {
    const job = make();
    const before = events(job).length;
    const r = merge(job);
    expect(r).toMatchObject({ outcome: 'blocked', code, jobId: job.id, mergeCommit: null });
    expect(r.reason).not.toBe('');
    expect(merges()).toHaveLength(0);
    expect(events(job)).toHaveLength(before);
    expect(getJob(store.db, job.id)).toMatchObject({ prState: job.prState, ownerSession: null });
  });

  it('a superseded job never merges, whatever GitHub says about its PR', () => {
    const next = completed();
    const old = completed({ job: { supersededBy: next.id } });
    expect(merge(old)).toMatchObject({
      outcome: 'blocked',
      code: 'superseded',
      relandJob: next.id,
    });
    expect(merges()).toHaveLength(0);
    // The dashboard does not offer it either.
    expect(detail(store, old.id).actions).not.toContain('merge');
    expect(() => dashboardAction(store, old.id, { action: 'merge' })).toThrow(/superseded/);
  });

  it('UNKNOWN mergeability is waiting: no merge, no lease, and the next call merges', () => {
    const job = completed();
    editPr(job, { mergeable: 'UNKNOWN' });
    const before = events(job).length;
    expect(merge(job)).toMatchObject({ outcome: 'waiting', code: null });
    expect(merges()).toHaveLength(0);
    expect(events(job)).toHaveLength(before);
    editPr(job, { mergeable: 'MERGEABLE' });
    expect(merge(job).outcome).toBe('merged');
  });

  it('a gh failure is the error outcome, not a refusal, and writes nothing', () => {
    const job = completed();
    shim.write({ fail: 'pr view' });
    const r = merge(job);
    expect(r).toMatchObject({ outcome: 'error', code: null });
    expect(r.reason).toContain('simulated failure');
    expect(events(job, 'pr.merged')).toEqual([]);
    shim.write({ fail: undefined });
    expect(merge(job).outcome).toBe('merged');
  });
});

describe('merging', () => {
  it('merges exactly the verified head as a merge commit and records what GitHub confirmed', () => {
    const job = completed();
    const r = merge(job);
    expect(r).toMatchObject({
      outcome: 'merged',
      code: null,
      jobId: job.id,
      ticketId: null,
      ticket: null,
      prUrl: job.prUrl,
      base: 'main',
      prHead: SHA,
      verifiedHead: SHA,
      mergeCommit: MERGE_COMMIT,
      verified: true,
      relandJob: null,
    });
    // One call: a merge commit pinned to the head, and no flag that bypasses or cleans up.
    expect(merges()).toEqual([['pr', 'merge', job.prUrl, '--merge', '--match-head-commit', SHA]]);
    expect(events(job, 'pr.merged').map((e) => e.payload)).toEqual([
      {
        head: SHA,
        ok: true,
        error: null,
        mergeCommit: MERGE_COMMIT,
        verifiedHead: SHA,
        verified: true,
        base: 'main',
        prUrl: job.prUrl,
        ticketId: null,
      },
    ]);
    expect(events(job, 'pr.merged')[0]?.actor).toBe('merger');
    // Only the PR state moved; the episode gave the job back.
    expect(getJob(store.db, job.id)).toMatchObject({
      prState: 'merged',
      stage: 'completed',
      status: 'completed',
      ciHead: SHA,
      ciStatus: 'passing',
      ownerSession: null,
      ownerToken: null,
    });
    expect(detail(store, job.id).merge).toMatchObject({
      mergeCommit: MERGE_COMMIT,
      verified: true,
    });
  });

  it('repeating a finished merge changes nothing', () => {
    const t = ticket();
    const job = completed({ ticket: t });
    expect(merge(job).outcome).toBe('merged');
    const before = events(job).length;
    const history = ticketHistory(store, t).length;
    for (const session of ['merger', 'someone-else']) {
      const again = mergeJob(store, job.id, { session });
      expect(again).toMatchObject({
        outcome: 'already_merged',
        verified: true,
        mergeCommit: MERGE_COMMIT,
        ticket: { completed: true, changed: false },
      });
    }
    expect(merges()).toHaveLength(1);
    expect(events(job)).toHaveLength(before);
    expect(ticketHistory(store, t)).toHaveLength(history);
  });

  it('a merge GitHub refuses is blocked, recorded with its message, and bypassed by nothing', () => {
    const job = completed();
    shim.write({ fail: 'pr merge' });
    expect(merge(job)).toMatchObject({
      outcome: 'blocked',
      code: 'github-refused',
      reason: 'gh pr merge failed: shim: simulated failure',
    });
    expect(merges()).toHaveLength(1);
    expect(getJob(store.db, job.id).prState).toBe('ready');
    expect(events(job, 'pr.merged').map((e) => e.payload)).toEqual([
      { head: SHA, ok: false, error: 'shim: simulated failure' },
    ]);
  });

  it('believes GitHub, not the exit status: a merge whose command timed out is recorded', () => {
    const t = ticket();
    const job = completed({ ticket: t });
    shim.write({ failAfter: 'pr merge' });
    expect(merge(job)).toMatchObject({
      outcome: 'merged',
      verified: true,
      mergeCommit: MERGE_COMMIT,
    });
    expect(getJob(store.db, job.id).prState).toBe('merged');
    expect(status(t)).toBe('done');
    expect(events(job, 'pr.merged').map((e) => e.payload['ok'])).toEqual([true]);
  });
});

describe('recovering a merge GitHub already made', () => {
  it('records it and closes the ticket without merging again, also where merging is not opted in', () => {
    // A crash, or a failed write, after GitHub merged: nothing local knows.
    const t = ticket();
    const job = completed({ ticket: t });
    githubMerged(job);
    setMergeAuthorization(store, clone, false);
    const r = merge(job);
    expect(r).toMatchObject({
      outcome: 'already_merged',
      verified: true,
      mergeCommit: MERGE_COMMIT,
      ticket: { id: t, completed: true, changed: true },
    });
    expect(merges()).toHaveLength(0);
    expect(getJob(store.db, job.id).prState).toBe('merged');
    expect(status(t)).toBe('done');
  });

  it('completes a record that says merged but has no evidence and an open ticket', () => {
    const t = ticket();
    const job = completed({ ticket: t, job: { prState: 'merged' } });
    githubMerged(job);
    expect(merge(job)).toMatchObject({ outcome: 'already_merged', ticket: { completed: true } });
    expect(events(job, 'pr.merged')).toHaveLength(1);
    expect(ticketEvents(t, 'ticket.completed')).toHaveLength(1);
  });

  it('a merge at another head is recorded as unverified and never closes the ticket', () => {
    const t = ticket();
    const job = completed({ ticket: t });
    githubMerged(job, OTHER);
    for (let i = 0; i < 2; i++) {
      const r = merge(job);
      expect(r).toMatchObject({
        outcome: 'already_merged',
        verified: false,
        prHead: OTHER,
        verifiedHead: SHA,
        ticket: { completed: false, status: 'in-progress' },
      });
      expect(r.ticket?.reason).toMatch(/not the verified/);
    }
    expect(events(job, 'pr.merged').map((e) => e.payload)).toMatchObject([
      { head: OTHER, verifiedHead: SHA, verified: false, mergeCommit: MERGE_COMMIT },
    ]);
    expect(status(t)).toBe('in-progress');
    // Said once on the ticket, however often the command runs.
    expect(ticketEvents(t, 'ticket.job-merged')).toHaveLength(1);
    expect(detail(store, job.id).merge).toMatchObject({ verified: false });
  });

  it('a PR merged for a job with no CI verdict of its own is recorded, unverified', () => {
    const t = ticket();
    const job = completed({ ticket: t, completion: { head: SHA, acceptedByHuman: true } });
    githubMerged(job);
    expect(merge(job)).toMatchObject({ outcome: 'already_merged', verified: false });
    expect(status(t)).toBe('in-progress');
  });

  it('records nothing until GitHub names the merge commit', () => {
    const job = completed();
    editPr(job, { state: 'MERGED' });
    expect(merge(job)).toMatchObject({ outcome: 'error', mergeCommit: null });
    expect(events(job, 'pr.merged')).toEqual([]);
    expect(getJob(store.db, job.id).prState).toBe('ready');
  });

  it('a merged PR that is not the job own is a discrepancy, not a record', () => {
    const job = completed();
    githubMerged(job);
    editPr(job, { baseRefName: 'release' });
    expect(merge(job)).toMatchObject({ outcome: 'blocked', code: 'wrong-base' });
    expect(getJob(store.db, job.id).prState).toBe('ready');
  });
});

describe('the ticket', () => {
  it('is closed with the merge evidence when no checklist item is unchecked', () => {
    const t = ticket('## What\n\n- [x] export button\n* [X] tests\n');
    const job = completed({ ticket: t });
    const r = merge(job);
    expect(r).toMatchObject({
      ticketId: t,
      ticket: { id: t, status: 'done', completed: true, reason: null, remaining: [] },
    });
    expect(r.reason).toContain('Ticket 0001 is done.');
    expect(ticketEvents(t, 'ticket.completed').map((e) => [e.payload, e.actor])).toEqual([
      [
        {
          from: 'in-progress',
          to: 'done',
          job: job.id,
          prUrl: job.prUrl,
          head: SHA,
          mergeCommit: MERGE_COMMIT,
          note: `merged ${job.prUrl ?? ''} (job ${job.id})`,
        },
        'merger',
      ],
    ]);
  });

  it('stays in progress while a checklist item is unchecked, and closes once it is ticked', () => {
    const body =
      '## What\n\n- [x] export button\n- [ ] rerun the import on staging\n1. [ ] tell support\n';
    const t = ticket(body);
    const job = completed({ ticket: t });
    const r = merge(job);
    expect(r).toMatchObject({
      outcome: 'merged',
      verified: true,
      ticket: {
        status: 'in-progress',
        completed: false,
        remaining: ['rerun the import on staging', 'tell support'],
      },
    });
    expect(r.reason).toContain(
      'Ticket 0001 stays in-progress: 2 unchecked checklist item(s) remain',
    );
    // The merge itself is recorded; the ticket was never marked done.
    expect(getJob(store.db, job.id).prState).toBe('merged');
    expect(ticketEvents(t, 'ticket.completed')).toEqual([]);
    expect(ticketEvents(t, 'ticket.job-merged').map((e) => e.payload)).toMatchObject([
      {
        job: job.id,
        mergeCommit: MERGE_COMMIT,
        verified: true,
        remaining: [expect.any(String), expect.any(String)],
      },
    ]);
    expect(merge(job)).toMatchObject({ outcome: 'already_merged', ticket: { changed: false } });
    expect(ticketEvents(t, 'ticket.job-merged')).toHaveLength(1);

    ticketAction(store, t, { action: 'edit', body: body.replaceAll('[ ]', '[x]') });
    expect(merge(job)).toMatchObject({
      outcome: 'already_merged',
      ticket: { completed: true, changed: true },
    });
    expect(status(t)).toBe('done');
    expect(merges()).toHaveLength(1);
  });

  it('closes once a deferred box left the body, and the follow-up that depends on it is ready', () => {
    const t = ticket('## What\n\n- [x] export button\n- [ ] rebuild the installed orch\n');
    const next = ticket('## What\n\n- [ ] rebuild the installed orch\n');
    const blocked = ticketAction(store, next, { action: 'dep-add', target: t });
    expect(blocked.blockedBy.map((b) => b.kind)).toEqual(['dependency']);
    ticketAction(store, t, {
      action: 'edit',
      body: '## What\n\n- [x] export button\n\nrebuild the installed orch (deferred to 0002)\n',
    });
    ticketAction(store, t, {
      action: 'note',
      text: 'rebuild the installed orch: deferred to 0002',
    });
    expect(merge(completed({ ticket: t }))).toMatchObject({
      outcome: 'merged',
      ticket: { status: 'done', completed: true, remaining: [] },
    });
    expect(showTicket(store, next).ticket).toMatchObject({ ready: true, blockedBy: [] });
  });

  it('a ticket someone dropped or closed meanwhile is left as they left it', () => {
    for (const action of ['drop', 'done'] as const) {
      const t = ticket();
      const job = completed({ ticket: t });
      ticketAction(store, t, { action });
      const history = ticketHistory(store, t).length;
      const r = merge(job);
      expect(r).toMatchObject({ outcome: 'merged', verified: true });
      expect(r.ticket).toMatchObject({ completed: action === 'done', changed: false });
      expect(status(t)).toBe(action === 'done' ? 'done' : 'dropped');
      expect(ticketHistory(store, t)).toHaveLength(history);
    }
  });

  it('is judged as it is when the merge is recorded, not as it was before', () => {
    const t = ticket();
    const job = completed({ ticket: t });
    ticketAction(store, t, { action: 'edit', title: 'Export CSV and TSV', body: '- [ ] TSV too' });
    expect(merge(job).ticket).toMatchObject({ completed: false, remaining: ['TSV too'] });
  });

  it('is not closed while another job is still working on it', () => {
    const t = ticket();
    const job = completed({ ticket: t });
    const other = createJob(store, {
      title: 'More',
      description: 'More',
      repo: REPO,
      repoPath: clone,
      baseBranch: 'main',
      ticketId: t,
    });
    const r = merge(job);
    expect(r.ticket).toMatchObject({ completed: false });
    expect(r.ticket?.reason).toContain(other.id);
  });

  it('reads only unchecked task items as open work', () => {
    expect(
      uncheckedItems('- [ ] a\r\n  * [ ] b\n+ [x] c\n2) [ ] d\n[ ] not a list\n- [] nor this'),
    ).toEqual(['a', 'b', 'd']);
    expect(uncheckedItems('')).toEqual([]);
  });
});

describe('a conflict is re-landed once', () => {
  const conflicting = (o: { ticket?: number } = {}) => {
    const job = completed(o);
    editPr(job, { mergeable: 'CONFLICTING' });
    return job;
  };

  it('creates one re-land job on the same ticket and supersedes the old one', () => {
    const t = ticket();
    const old = conflicting({ ticket: t });
    const r = merge(old);
    expect(r).toMatchObject({ outcome: 'reland', code: null, ticket: null });
    const next = getJob(store.db, r.relandJob ?? '');
    expect(next).toMatchObject({
      ticketId: t,
      title: 'Add CSV export (re-land)',
      repo: REPO,
      baseBranch: 'main',
      stage: 'spec',
      status: 'pending',
      ownerSession: null,
    });
    expect(next.description).toContain(`Re-land the work of ${old.id}`);
    expect(next.description).toContain(`branch starts from ${String(old.branch)}'s head`);
    expect(getJob(store.db, old.id).supersededBy).toBe(next.id);
    expect(showTicket(store, t).ticket).toMatchObject({
      status: 'in-progress',
      activeJob: next.id,
    });
    expect(merges()).toHaveLength(0);

    // A retry finds the successor instead of making another, and the old PR stays unmerged even
    // when GitHub calls it mergeable again.
    const count = listJobs(store.db).length;
    editPr(old, { mergeable: 'MERGEABLE' });
    expect(merge(old)).toMatchObject({
      outcome: 'blocked',
      code: 'superseded',
      relandJob: next.id,
    });
    expect(listJobs(store.db)).toHaveLength(count);
    expect(merges()).toHaveLength(0);

    // The re-land goes through the factory and merges like any job; that closes the ticket.
    const done = finish(next);
    expect(merge(done)).toMatchObject({ outcome: 'merged', ticket: { completed: true } });
  });

  it('a second conflict stops: no third job', () => {
    const old = conflicting();
    const next = finish(getJob(store.db, merge(old).relandJob ?? ''));
    editPr(next, { mergeable: 'CONFLICTING' });
    const count = listJobs(store.db).length;
    expect(merge(next)).toMatchObject({
      outcome: 'blocked',
      code: 'second-conflict',
      relandJob: null,
    });
    expect(listJobs(store.db)).toHaveLength(count);
    expect(getJob(store.db, next.id).supersededBy).toBeNull();
  });

  it('works for a job without a ticket, and never leaves a re-land without its supersession', () => {
    const old = conflicting();
    const { token } = claimJob(store, old.id, { session: 'merger' });
    const next = relandJob(store, old, token, 'merger');
    expect(next.ticketId).toBeNull();
    expect(getJob(store.db, old.id).supersededBy).toBe(next.id);
    // Creating and superseding are one transaction: a second attempt creates nothing.
    const count = listJobs(store.db).length;
    expect(() => relandJob(store, old, token, 'merger')).toThrow(ValidationError);
    expect(listJobs(store.db)).toHaveLength(count);
  });

  it('a re-land that cannot be created blocks, and the old job stays unsuperseded', () => {
    const t = ticket();
    const old = conflicting({ ticket: t });
    ticketAction(store, t, { action: 'drop' });
    const count = listJobs(store.db).length;
    expect(merge(old)).toMatchObject({ outcome: 'blocked', code: 'reland-refused' });
    expect(listJobs(store.db)).toHaveLength(count);
    expect(getJob(store.db, old.id).supersededBy).toBeNull();
  });

  it('is not started where merging is not opted in', () => {
    const old = conflicting();
    setMergeAuthorization(store, clone, false);
    const count = listJobs(store.db).length;
    expect(merge(old)).toMatchObject({ outcome: 'blocked', code: 'not-authorized' });
    expect(listJobs(store.db)).toHaveLength(count);
  });
});

describe('two callers', () => {
  it('a live lease held by another session is an ownership error; after it lapses the merge runs', () => {
    const job = completed();
    claimJob(store, job.id, { session: 'other', leaseMinutes: 5 });
    expect(() => merge(job)).toThrow(OwnershipError);
    expect(merges()).toHaveLength(0);
    store.db
      .update(jobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(jobs.id, job.id))
      .run();
    expect(merge(job).outcome).toBe('merged');
  });

  it('two that both see the PR merged leave one record and one ticket completion', () => {
    const t = ticket();
    const job = completed({ ticket: t });
    githubMerged(job);
    expect(merge(job, 'first').outcome).toBe('already_merged');
    expect(merge(job, 'second').outcome).toBe('already_merged');
    expect(events(job, 'pr.merged')).toHaveLength(1);
    expect(ticketEvents(t, 'ticket.completed')).toHaveLength(1);
  });
});

describe('authorization', () => {
  it('is off by default, per repository, and kept in the private factory.json', () => {
    const fresh = tempStore();
    try {
      const file = join(fresh.home, 'factory.json');
      expect(mergeAuthorization(fresh, clone)).toEqual({ repo: REPO, enabled: false, file });
      expect(existsSync(file)).toBe(false);
      writeFileSync(file, JSON.stringify({ maxRounds: 4 }));
      expect(setMergeAuthorization(fresh, clone, true)).toEqual({
        repo: REPO,
        enabled: true,
        file,
      });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ maxRounds: 4, mergeRepos: [REPO] });
      expect(mergeAuthorized(fresh, REPO)).toBe(true);
      expect(mergeAuthorized(fresh, 'github.com/acme/beta')).toBe(false);
      expect(setMergeAuthorization(fresh, clone, false).enabled).toBe(false);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ maxRounds: 4, mergeRepos: [] });
      // A repository without a remote has no identity to authorize.
      expect(() => setMergeAuthorization(fresh, makeRepo(), true)).toThrow(/no origin remote/);
    } finally {
      fresh.cleanup();
    }
  });

  it("a human's dashboard Merge needs no opt-in, runs the same operation, and closes the ticket", () => {
    setMergeAuthorization(store, clone, false);
    const t = ticket();
    const job = completed({ ticket: t });
    expect(merge(job)).toMatchObject({ outcome: 'blocked', code: 'not-authorized' });
    const r = dashboardAction(store, job.id, { action: 'merge' });
    expect(r.message).toContain(
      `Merged ${job.prUrl ?? ''} at ${SHA.slice(0, 7)}. Ticket 0001 is done.`,
    );
    expect(events(job, 'pr.merged').map((e) => [e.payload['mergeCommit'], e.actor])).toEqual([
      [MERGE_COMMIT, 'dashboard'],
    ]);
    expect(status(t)).toBe('done');
  });
});

describe('orch job merge', () => {
  const cli = (args: string[]) => orch(store.home, tmpdir(), args, shim.env);

  it('is opted in per repository from the CLI, then merges and reports in text and JSON', () => {
    setMergeAuthorization(store, clone, false);
    const job = completed();
    const refused = cli(['--json', 'job', 'merge', job.id]);
    expect(refused.code).toBe(1);
    expect(json<MergeResult>(refused)).toMatchObject({
      outcome: 'blocked',
      code: 'not-authorized',
    });

    const config = ['factory', 'config', 'merge'];
    expect(json(cli(['--json', ...config, 'status', '--repo', clone]))).toMatchObject({
      enabled: false,
    });
    expect(json(cli(['--json', ...config, 'enable', '--repo', clone]))).toMatchObject({
      repo: REPO,
      enabled: true,
    });
    expect(cli([...config, 'nonsense']).code).toBe(2);

    const merged = cli(['job', 'merge', job.id]);
    expect(merged.code, merged.err).toBe(0);
    expect(merged.out).toMatch(/^MERGED: /);
    expect(merged.out).toContain(`merge commit  ${MERGE_COMMIT}`);
    expect(merges()).toEqual([['pr', 'merge', job.prUrl, '--merge', '--match-head-commit', SHA]]);
    // Each process merges under a name of its own.
    expect(events(job, 'pr.merged')[0]?.actor).toMatch(/^orch-merge-\d+$/);

    const again = cli(['--json', 'job', 'merge', job.id]);
    expect(again.code).toBe(0);
    expect(json<MergeResult>(again)).toMatchObject({
      outcome: 'already_merged',
      jobId: job.id,
      mergeCommit: MERGE_COMMIT,
      verified: true,
    });
    expect(merges()).toHaveLength(1);

    expect(json(cli(['--json', ...config, 'disable', '--repo', clone]))).toMatchObject({
      enabled: false,
    });
    expect(cli(['job', 'merge', 'job-nope']).code).toBe(3);
    expect(cli(['job', 'merge']).code).toBe(2);
  });

  it('an unverified merge is reconciled but exits 1, on the first call and on a repeat', () => {
    const job = completed();
    githubMerged(job, OTHER);
    for (let i = 0; i < 2; i++) {
      const r = cli(['--json', 'job', 'merge', job.id]);
      expect(r.code).toBe(1);
      expect(json<MergeResult>(r)).toMatchObject({
        outcome: 'already_merged',
        verified: false,
        mergeCommit: MERGE_COMMIT,
      });
    }
    expect(events(job, 'pr.merged')).toHaveLength(1);
    expect(cli(['job', 'merge', job.id]).out).toMatch(/^ALREADY_MERGED: .*Not verified/);
  });

  it('waiting and blocked exit 1 with the outcome on stdout', () => {
    const job = completed();
    editPr(job, { mergeable: 'UNKNOWN' });
    const waiting = cli(['job', 'merge', job.id]);
    expect(waiting.code).toBe(1);
    expect(waiting.out).toMatch(/^WAITING: /);
    editPr(job, { mergeable: 'MERGEABLE', isDraft: true });
    const blocked = cli(['job', 'merge', job.id]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(/^BLOCKED \(pr-draft\): /);
  });
});

describe('a PR that changes .github/workflows/ needs a human merge', () => {
  const WORKFLOW = '.github/workflows/ci.yml';
  interface File {
    filename: string;
    previous_filename?: string;
  }
  const plain = (count: number): File[] =>
    Array.from({ length: count }, (_, i) => ({ filename: `src/f${String(i)}.ts` }));
  /** A completed job whose PR's file list on GitHub is `files` (a string is sent as is). */
  const jobWith = (files: File[] | string, over: Record<string, unknown> = {}): Job => {
    const job = completed();
    editPr(job, { files, ...over });
    return job;
  };
  const blockedAsWorkflow = (job: Job) => {
    const before = events(job).length;
    const merged = merges().length;
    const r = merge(job);
    expect(r).toMatchObject({ outcome: 'blocked', code: 'workflow-changed' });
    expect(r.reason).toContain('.github/workflows/');
    expect(merges()).toHaveLength(merged);
    expect(events(job)).toHaveLength(before);
  };

  const touching: [string, File[]][] = [
    ['adds', [{ filename: '.github/workflows/new.yml' }]],
    ['edits', [{ filename: 'src/a.ts' }, { filename: WORKFLOW }]],
    ['deletes', [{ filename: WORKFLOW }]],
    ['replaces .github', [{ filename: '.github' }]],
    ['replaces .github/workflows', [{ filename: '.github/workflows' }]],
    ['moves out', [{ filename: 'ci-moved.yml', previous_filename: WORKFLOW }]],
    ['moves in', [{ filename: WORKFLOW, previous_filename: 'ci-moved.yml' }]],
  ];
  it.each(touching)('a session merge of a PR that %s a workflow is blocked', (_name, files) => {
    blockedAsWorkflow(jobWith(files));
  });

  it('fails closed when GitHub cannot list the files, or lists them as nonsense', () => {
    const failing = jobWith(plain(1));
    shim.write({ fail: 'api repos/' });
    blockedAsWorkflow(failing);
    shim.write({ fail: undefined });
    blockedAsWorkflow(jobWith('not json'));
    blockedAsWorkflow(jobWith('{"filename":"src/a.ts"}'));
    blockedAsWorkflow(jobWith([{ name: 'src/a.ts' } as unknown as File]));
  });

  it('fails closed when the list is shorter than the PR, or the PR gives no count', () => {
    blockedAsWorkflow(jobWith(plain(3000), { changedFiles: 3001 }));
    blockedAsWorkflow(jobWith(plain(100), { changedFiles: 150 }));
    blockedAsWorkflow(jobWith(plain(1), { changedFiles: null }));
  });

  it('reads every page: 150 plain files merge, one workflow on page two blocks', () => {
    expect(merge(jobWith(plain(150))).outcome).toBe('merged');
    const files = plain(150);
    files[120] = { filename: WORKFLOW };
    blockedAsWorkflow(jobWith(files));
  });

  it('local Git has no say: only GitHub list counts', () => {
    // The clone's main is the job head: locally the job changes nothing, GitHub lists a workflow.
    blockedAsWorkflow(jobWith([{ filename: WORKFLOW }]));
    // A local branch that edits a workflow, while GitHub's list does not show one.
    gitIn(clone, 'checkout', '-q', '-b', 'wf-local', 'main');
    commitFile(clone, WORKFLOW, 'on: push\n');
    const head = gitIn(clone, 'rev-parse', 'HEAD');
    gitIn(clone, 'checkout', '-q', 'main');
    const job = completed({ job: { ciHead: head } });
    editPr(job, { headRefOid: head, files: plain(1) });
    expect(merge(job).outcome).toBe('merged');
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'ops', 'merge.ts'), 'utf8');
    expect(source).not.toMatch(
      /'merge-base'|'diff'|info\/grafts|is-shallow-repository|commitGraph/,
    );
  });

  it('reads the files before the PR it judges, and a moved head is still head-changed', () => {
    const job = jobWith(plain(1));
    shim.write({ calls: [] });
    expect(merge(job).outcome).toBe('merged');
    const kinds = shim
      .read()
      .calls.map((c) =>
        c[0] === 'api' && c[1]?.includes('/files') ? 'files' : `${c[0] ?? ''} ${c[1] ?? ''}`,
      );
    expect(kinds).toEqual(['files', 'pr view', 'files', 'pr view', 'pr merge', 'pr view']);
    const moved = jobWith([{ filename: WORKFLOW }], { headRefOid: OTHER });
    expect(merge(moved)).toMatchObject({ outcome: 'blocked', code: 'head-changed' });
  });

  it('the dashboard merges it; a list that leaves workflows alone merges from a session', () => {
    const job = jobWith([{ filename: WORKFLOW }]);
    expect(mergeJob(store, job.id, { session: 'dashboard', mode: 'dashboard' })).toMatchObject({
      outcome: 'merged',
      verified: true,
    });
    expect(merge(jobWith([{ filename: 'src/b.ts' }])).outcome).toBe('merged');
    // A PR GitHub already merged is recorded whatever it changed.
    const done = jobWith([{ filename: WORKFLOW }]);
    githubMerged(done);
    expect(merge(done)).toMatchObject({ outcome: 'already_merged', verified: true });
  });
});
