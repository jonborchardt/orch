/**
 * The merge receipt (ticket 0155): one summary of recorded evidence, written into the PR body when
 * the ci stage completes and shown on the ticket's detail. Read-only; it decides nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { resumeFactoryJob } from '../src/ops/factory.ts';
import { buildReceipt, receiptMarkdown } from '../src/ops/receipt.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { appendEvent } from '../src/storage/events.ts';
import { claimJob, getJob, recordMerge } from '../src/storage/jobs.ts';
import { events } from '../src/storage/schema.ts';
import { checks, clone, job, reconcile, run, shim, store } from './ci-fixture.ts';
import { type Ctx, go, head, SESSION, start, toCi, toReview, verdict } from './drive.ts';
import { gitIn } from './helpers.ts';

const markdown = (id: string) => receiptMarkdown(buildReceipt(store, getJob(store.db, id)));
const prBodyOnGitHub = () => (shim.read().prs[0] as { body: string }).body;

/** A full job for a new ticket, claimed, driven to ci with passing checks for its head. */
function ticketJobAtCi(): { c: Ctx; ticket: number; sha: string } {
  const ticket = addTicket(store, { title: 'Export CSV', repo: clone }).id;
  const { job: j } = dispatchJob(store, { ticket, session: SESSION, cwd: clone });
  const r = resumeFactoryJob(store, j.id, { session: SESSION });
  const c = { id: j.id, token: r.token, dir: r.plan.artifactDir, wt: r.job.worktreePath ?? '' };
  toCi(store, c);
  const sha = head(c.wt);
  checks(sha, [run('test', 'success')]);
  return { c, ticket, sha };
}

describe('merge receipt', () => {
  it('completing ci writes pr.md plus the receipt into the PR body, and the ticket shows it (AC1, AC3, AC4, AC6)', () => {
    const { c, ticket, sha } = ticketJobAtCi();
    expect(showTicket(store, ticket).receipt).toBeNull();

    const r = reconcile(c);
    expect(r).toMatchObject({ action: 'complete', receipt: 'updated', receiptError: null });
    expect(job(c).stage).toBe('completed');
    const prMd = readFileSync(join(c.dir, 'pr.md'), 'utf8').trimEnd();
    const body = prBodyOnGitHub();
    expect(body.startsWith(prMd)).toBe(true);
    expect(body).toContain('## Merge receipt');
    expect(body).toContain(`Verified commit: \`${sha}\``);

    const md = markdown(c.id);
    expect(md).toContain(`Verified commit: \`${sha}\``);
    expect(md).toMatch(/- check: passed, \d+\.\d s/);
    expect(md).toContain('- Round 1: ');
    for (const reviewer of ['security', 'correctness', 'code-quality']) {
      expect(md).toContain(`${reviewer} pass`);
    }
    const j = job(c);
    expect(md).toContain(
      `Review rounds ${String(j.round)}/${String(j.maxRounds)}, CI repairs 0/${String(j.maxCiRepairs)}, CI re-runs 0`,
    );
    // The job changed src/export.ts only: nothing sensitive.
    expect(md).toContain('- Sensitive changes: none');
    expect(md).toContain('Not merged.');
    expect(showTicket(store, ticket).receipt).toEqual({ jobId: c.id, markdown: md });

    // Once merged, the receipt carries the merge evidence.
    const { token } = claimJob(store, c.id, { session: SESSION });
    const mergeCommit = gitIn(clone, 'rev-parse', 'HEAD');
    recordMerge(store, c.id, { token }, { head: sha, mergeCommit, verified: true, reason: null });
    const merged = showTicket(store, ticket).receipt?.markdown ?? '';
    expect(merged).toContain(
      `Merged head \`${sha}\`, merge commit \`${mergeCommit}\`, verified: yes`,
    );
    expect(merged).not.toContain('Not merged.');
  });

  it('a failed PR body write leaves the completed job as it is and reports the error (AC5)', () => {
    const { c, sha } = ticketJobAtCi();
    shim.write({ fail: 'pr edit' });
    const r = reconcile(c);
    expect(r).toMatchObject({ action: 'complete', receipt: 'failed' });
    expect(r.receiptError).toContain('simulated failure');
    expect(job(c)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ciStatus: 'passing',
      ciHead: sha,
      prState: 'ready',
      ownerToken: null,
    });
    expect(prBodyOnGitHub()).not.toContain('## Merge receipt');
  });

  it('lists human decisions with their reasons and targets (AC2)', () => {
    const c = start(store, clone);
    const at = new Date().toISOString();
    const seed = (type: string, payload: Record<string, unknown>, actor: string) =>
      appendEvent(store.db, c.id, type, payload, actor, at);
    seed('job.blocked', { from: 'review', reason: 'Round budget spent' }, SESSION);
    seed('job.resumed', { to: 'build', maxRounds: 4 }, 'jon');
    seed('job.blocked', { from: 'ci', reason: 'No required checks are configured' }, SESSION);
    seed('job.resumed', { to: 'completed' }, 'jon');
    seed(
      'job.completed',
      { acceptedByHuman: true, reason: 'CI is not set up for this repo', ciStatus: 'none' },
      'jon',
    );
    const md = markdown(c.id);
    expect(md).toContain('- Blocked in review: Round budget spent; resumed to build by jon');
    expect(md).toContain(
      '- Blocked in ci: No required checks are configured; resumed to completed by jon',
    );
    expect(md).toContain('- Delivery accepted by jon: CI is not set up for this repo (CI none)');
    // Nothing verified, nothing merged: said plainly.
    expect(md).toContain('Verified commit: unknown');
    expect(md).toContain('No verification run recorded for this commit.');
    expect(md).toContain('Not merged.');
  });

  it('shows the drawn model of every role and each review, or "not recorded" (ticket 0168 AC8)', () => {
    writeFileSync(
      join(store.paths.config, 'factory.json'),
      JSON.stringify({ models: { builder: 'opus', security: 'opus', correctness: 'sonnet' } }),
    );
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'start');
    verdict(store, c, 'security');
    verdict(store, c, 'correctness');
    const r = buildReceipt(store, getJob(store.db, c.id));
    expect(r.models?.['builder']).toEqual({ model: 'opus' });
    expect(r.models?.['correctness']).toEqual({ model: 'sonnet', sameAsAuthor: false });
    expect(r.reviews).toContainEqual(
      expect.objectContaining({ reviewer: 'security', model: 'opus', sameAsAuthor: true }),
    );
    const md = receiptMarkdown(r);
    expect(md).toContain('### Models');
    expect(md).toContain('- builder: opus\n');
    expect(md).toContain('- spec-challenger: sonnet, same as author: no');
    expect(md).toContain('security pass (opus, same as author: yes)');
    expect(md).toContain('correctness pass (sonnet, same as author: no)');

    // A job from before pools: no event, null review columns.
    const legacy = start(store, clone, 'Legacy job');
    store.db
      .delete(events)
      .where(and(eq(events.jobId, legacy.id), eq(events.type, 'models.drawn')))
      .run();
    toReview(store, legacy);
    go(store, legacy, 'start');
    verdict(store, legacy, 'security');
    const old = buildReceipt(store, getJob(store.db, legacy.id));
    expect(old.models).toBeNull();
    expect(old.reviews[0]).toMatchObject({ model: null, sameAsAuthor: null });
    const oldMd = receiptMarkdown(old);
    expect(oldMd).toContain('### Models\n\nNot recorded.');
    expect(oldMd).toContain('security pass (model not recorded, same as author: not recorded)');
  });
});
