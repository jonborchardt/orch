/**
 * The merged status mail: a job driven through its stages to a confirmed merge sends exactly one
 * mail, the merged receipt (PR link, merge commit, and the run summary's cost line); a merge
 * GitHub refused sends none. Uses tests/ci-fixture.ts and the fake SMTPS server.
 */
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { now } from '../src/core/workflow.ts';
import { reportJobMail } from '../src/ops/mail.ts';
import { mergeJob, setMergeAuthorization } from '../src/ops/merge.ts';
import { formatSummary } from '../src/ops/run-report.ts';
import { addTicket } from '../src/ops/tickets.ts';
import { appendEvent, listEvents, maxEventId } from '../src/storage/events.ts';
import { mergeEvidence } from '../src/storage/jobs.ts';
import { insertUsage } from '../src/storage/usage.ts';
import { checks, clone, job, reconcile, run, shim, store } from './ci-fixture.ts';
import { deliverPr, fastBuild, go, head, startFast } from './drive.ts';
import { CERT, type FakeSmtp, fakeSmtp } from './mail-server.ts';

let smtp: FakeSmtp;
beforeAll(async () => {
  smtp = await fakeSmtp();
  setDefaultCACertificates([...getCACertificates('default'), CERT]);
});
afterAll(async () => {
  await smtp.close();
});

describe('merged mail', () => {
  it('a job driven to a confirmed merge sends exactly one mail: the merged receipt', async () => {
    const mark = maxEventId(store.db);
    const before = smtp.messages.length;
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
    shim.write({ api: { [`repos/acme/alpha/compare/main...${h1}`]: { behind_by: 0 } } });

    // Every stage started and completed, and the job completed: nothing mailed.
    expect(await reportJobMail(store, mark, smtp.env())).toEqual([]);

    // A merge GitHub refused is not the receipt: still nothing.
    shim.write({ fail: 'pr merge' });
    expect(mergeJob(store, c.id, { session: 'merger' })).toMatchObject({ code: 'github-refused' });
    expect(await reportJobMail(store, mark, smtp.env())).toEqual([]);

    // Recorded cost, so the cost line carries numbers rather than "not recorded".
    appendEvent(store.db, c.id, 'runner.session', { seconds: 125 }, null, now());
    insertUsage(store, {
      ref: 'merged-mail-session',
      jobId: c.id,
      source: 'runner',
      hours: [{ hour: 0, input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }],
    });

    shim.write({ fail: undefined });
    expect(mergeJob(store, c.id, { session: 'merger' })).toMatchObject({ outcome: 'merged' });
    const out = await reportJobMail(store, mark, smtp.env());
    expect(out).toHaveLength(1);
    expect(out[0]?.error).toBeNull();

    const mails = smtp.messages.slice(before);
    expect(mails).toHaveLength(1);
    const body = mails[0]?.body.replace(/\r\n/g, '\n') ?? '';
    const lines = body.split('\n');
    expect(mails[0]?.headers['in-reply-to']).toBeUndefined();
    const prUrl = job(c).prUrl ?? '';
    expect(prUrl).not.toBe('');
    expect(lines).toContain(`PR:     ${prUrl}`);
    const commit = mergeEvidence(store.db, c.id)?.['mergeCommit'];
    expect(typeof commit).toBe('string');
    expect(lines).toContain(`Merged: ${String(commit)}`);
    const cost = `cost of job ${c.id} only: 2 min 5 s, 10 tokens (input 1, output 2, cache read 3, cache creation 4)`;
    expect(lines).toContain(cost);
    expect(body).toContain('pr.merged');
    expect(body).not.toContain('stage.');

    // Character-identical to the line the end-of-session summary prints for the same job.
    const summary = formatSummary({
      reason: 'queue empty',
      stopped: false,
      interrupted: false,
      attempted: 1,
      completed: 1,
      blocked: 0,
      relands: 0,
      elapsedSeconds: 125,
      tickets: [],
      skipped: [],
      waiting: [],
      merged: [
        {
          ticketId,
          title: 'Export CSV',
          jobId: c.id,
          head: h1,
          mergeCommit: String(commit),
          prUrl,
          seconds: 125,
          tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
        },
      ],
    });
    expect(summary.split('\n')).toContain(`     ${cost}`);

    const sent = listEvents(store.db, c.id, 1000).filter((e) => e.type === 'mail.sent');
    expect(sent).toHaveLength(1);
  });
});
