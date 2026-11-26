/**
 * The recovery worker's hook: a pass that records `recovery.failed` mails it into the job's
 * thread. Split from mail-jobs.test.ts because it drives a job to the ci stage (ci-fixture).
 */
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportJobMail } from '../src/ops/mail.ts';
import { runWorker } from '../src/ops/recover.ts';
import { listEvents } from '../src/storage/events.ts';
import { releaseJob } from '../src/storage/jobs.ts';
import { start, toCi } from './drive.ts';
import { clone, job, shim, store } from './ci-fixture.ts';
import { CERT, type FakeSmtp, fakeSmtp } from './mail-server.ts';

let smtp: FakeSmtp;
beforeAll(async () => {
  smtp = await fakeSmtp();
  setDefaultCACertificates([...getCACertificates('default'), CERT]);
});
afterAll(async () => {
  for (const k of Object.keys(smtp.env())) Reflect.deleteProperty(process.env, k);
  await smtp.close();
});

describe('recovery worker mail', () => {
  it('mails a failed recovery attempt, starting the job thread', async () => {
    const c = start(store, clone);
    toCi(store, c);
    releaseJob(store, c.id, { token: c.token });
    Object.assign(process.env, smtp.env());
    // Driving the job to ci recorded only unmailed events: no thread yet.
    expect(await reportJobMail(store, 0)).toEqual([]);

    shim.write({ fail: 'pr view' }); // the probe answers, the attempt fails
    const before = smtp.messages.length;
    const pass = await runWorker(store, { once: true });
    expect(pass.jobs.find((j) => j.jobId === c.id)?.action).toBe('failed');

    const mails = smtp.messages.slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.headers['in-reply-to']).toBeUndefined(); // the thread's first mail
    expect(mails[0]?.body).toContain('recovery.failed');
    expect(job(c).mailThreadId).toBe(mails[0]?.headers['message-id']);
    expect(job(c).mailLastId).toBe(mails[0]?.headers['message-id']);
    const types = listEvents(store.db, c.id, 1000).map((e) => e.type);
    expect(types.filter((t) => t === 'mail.sent')).toHaveLength(1);
  });
});
