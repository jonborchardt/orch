/**
 * The end-of-session report (src/ops/run-report.ts): merged tickets with head, receipt link, and
 * the recorded cost of their result job; what needs a person; what was passed over; and the one
 * session mail carrying the same text when mail is configured.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { summaryExitCode } from '../src/cli/run.ts';
import { ticketKey } from '../src/core/tickets.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { buildReceipt } from '../src/ops/receipt.ts';
import { RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { formatSummary } from '../src/ops/run-report.ts';
import { claimJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import { insertUsage } from '../src/storage/usage.ts';
import { CERT, type FakeSmtp, fakeSmtp } from './mail-server.ts';
import {
  clone,
  done,
  eventsOf,
  finish,
  jobsOf,
  launcher,
  one,
  queue,
  quick,
  status,
  store,
  ticket,
} from './run-fixture.ts';

let smtp: FakeSmtp;
let refusing: FakeSmtp;
beforeAll(async () => {
  smtp = await fakeSmtp();
  refusing = await fakeSmtp({ rejectAuth: true });
  setDefaultCACertificates([...getCACertificates('default'), CERT]);
});
afterAll(async () => {
  await smtp.close();
  await refusing.close();
});

const escalate = (job: Job): void => {
  const { token } = claimJob(store, job.id, { session: RUNNER_SESSION });
  transitionJob(store, job.id, 'start', { token });
  transitionJob(store, job.id, 'escalate', { token, reason: 'two designs are possible' });
};

const usage = (job: Job, ref: string, n: number) => {
  insertUsage(store, {
    ref,
    jobId: job.id,
    source: 'runner',
    hours: [{ hour: 0, input: n, output: 2 * n, cacheRead: 3 * n, cacheCreation: 4 * n }],
  });
};

/** Mail settings in the store's own config directory; `extra` lines override. */
function mailEnv(s: FakeSmtp | null, extra: Record<string, string> = {}) {
  mkdirSync(store.paths.config, { recursive: true });
  const lines = Object.entries({ ...(s?.env() ?? {}), ...extra }).map(([k, v]) => `${k}=${v}`);
  writeFileSync(join(store.paths.config, 'mail.env'), lines.join('\n'));
}

describe('the end-of-session report', () => {
  it('lists merged with head, receipt, and its own job cost, then needs you, then passed over', async () => {
    const first = ticket('Needs a person', { priority: 'P1' });
    const second = ticket('Merges', { priority: 'P2' });
    const l = launcher(
      (job) => {
        usage(job, 'other-job-session', 1000); // another job's rows: never counted
        escalate(job);
      },
      (job) => {
        usage(job, 'a', 1);
        usage(job, 'b', 10);
        finish(job);
      },
    );

    const s = await queue(l);

    const jobId = jobsOf(second)[0]?.id ?? '';
    const job = getJob(store.db, jobId);
    expect(s.merged).toHaveLength(1);
    const m = s.merged[0];
    const seconds = eventsOf(jobId, 'runner.session').reduce(
      (n, e) => n + (e.payload['seconds'] as number),
      0,
    );
    expect(m).toMatchObject({
      ticketId: second,
      jobId,
      prUrl: job.prUrl,
      seconds,
      tokens: { input: 11, output: 22, cacheRead: 33, cacheCreation: 44 },
    });
    // The same head the receipt shows.
    expect(m?.head).toBe(buildReceipt(store, job).merge?.head);
    expect(m?.head).toMatch(/^[0-9a-f]{40}$/);

    const text = formatSummary(s);
    const merged = text.indexOf('Merged (1)');
    const needs = text.indexOf('Needs you (1)');
    expect(merged).toBeGreaterThan(-1);
    expect(needs).toBeGreaterThan(merged);
    expect(text).not.toContain('Passed over');
    expect(text).toContain(`${ticketKey(second)} Merges`);
    expect(text).toContain(`job ${jobId}, head ${(m?.head ?? '').slice(0, 12)}`);
    expect(text).toContain(`receipt: ${job.prUrl ?? '?'}`);
    expect(text).toContain(`cost of job ${jobId} only: 0 min ${String(seconds)} s, 110 tokens`);
    expect(text).toContain(`${ticketKey(first)} needs-human: job`);
    expect(summaryExitCode(s)).toBe(1);
  });

  it('says "not recorded" for a merge without a launch or token rows', async () => {
    const id = ticket('Already built');
    const job = finish(dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job);

    const s = await one(launcher(), id);

    expect(s.merged[0]).toMatchObject({ jobId: job.id, seconds: null, tokens: null });
    expect(formatSummary(s)).toContain('time not recorded, tokens not recorded');
  });
});

describe('the session mail', () => {
  it('sends one mail whose body is the report, with the prefix and counts in the subject', async () => {
    mailEnv(smtp, { MAIL_SUBJECT_PREFIX: '[run-test]' });
    const before = smtp.messages.length;
    const id = ticket('Mailed');
    const logs: string[] = [];

    const s = await startSession(
      store,
      { mode: 'queue' },
      { launch: launcher(done).launch, ...quick, log: (l) => logs.push(l) },
    );

    expect(status(id)).toBe('done');
    const sent = smtp.messages
      .slice(before)
      .filter((m) => m.headers['subject']?.includes('session'));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['subject']).toBe('[run-test] session ended: 1 merged, 0 need you');
    expect(sent[0]?.body).toBe(formatSummary(s).replace(/\n/g, '\r\n'));
    expect(logs.filter((l) => l.startsWith('session mail'))).toEqual([]);
  });

  it('without mail configured sends nothing and logs nothing', async () => {
    const before = smtp.messages.length;
    ticket('Quiet');
    const logs: string[] = [];

    await startSession(
      store,
      { mode: 'queue' },
      { launch: launcher(done).launch, ...quick, log: (l) => logs.push(l) },
    );

    expect(smtp.messages.length).toBe(before);
    expect(logs.filter((l) => l.includes('mail'))).toEqual([]);
  });

  for (const [name, setup] of [
    [
      'a refused send',
      () => {
        mailEnv(refusing);
      },
    ],
    [
      'a partial configuration',
      () => {
        mailEnv(null, { MAIL_SMTP_HOST: '127.0.0.1' });
      },
    ],
  ] as const) {
    it(`${name} is one log line and changes nothing else`, async () => {
      setup();
      const id = ticket('Unmailed');
      const logs: string[] = [];

      const s = await startSession(
        store,
        { mode: 'queue' },
        { launch: launcher(done).launch, ...quick, log: (l) => logs.push(l) },
      );

      expect(s).toMatchObject({ attempted: 1, completed: 1, blocked: 0, stopped: false });
      expect(summaryExitCode(s)).toBe(0);
      expect(status(id)).toBe('done');
      expect(logs.filter((l) => l.startsWith('session mail not sent:'))).toHaveLength(1);
    });
  }
});
