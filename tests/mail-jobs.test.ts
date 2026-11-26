/**
 * Job status mail: one mail per store-backed command that recorded reported events, threaded per
 * job; nothing when mail is off; a failed send is recorded once and never fails, retries, or
 * changes the command; the claim is metadata and at-most-once; the dashboard hook mails too.
 * Runs against the in-process fake SMTPS server, so CLI calls use `orchAsync`.
 */
import { tmpdir } from 'node:os';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import { reportJobMail } from '../src/ops/mail.ts';
import { startServer } from '../src/server/http.ts';
import type { SessionInfo } from '../src/server/types.ts';
import { openStore } from '../src/storage/client.ts';
import { listEvents, maxEventId } from '../src/storage/events.ts';
import {
  claimJob,
  claimMailCursor,
  createJob,
  getJob,
  recordMailOutcome,
  transitionJob,
} from '../src/storage/jobs.ts';
import { homePaths, makeRepo, orchAsync, tempDir, tempStore, writeArtifact } from './helpers.ts';
import { CERT, type FakeSmtp, fakeSmtp, FIXTURE_CERT, PASSWORD } from './mail-server.ts';

let smtp: FakeSmtp;
beforeAll(async () => {
  smtp = await fakeSmtp();
  // In-process sends (dashboard, reportJobMail) trust the fixture certificate like the CLI does.
  setDefaultCACertificates([...getCACertificates('default'), CERT]);
});
afterAll(async () => {
  await smtp.close();
});

const mailEnv = (s: FakeSmtp = smtp) => ({ ...s.env(), NODE_EXTRA_CA_CERTS: FIXTURE_CERT });

/** The job row and its events, read from the CLI's database. */
function inspect(home: string, id: string) {
  const store = openStore(homePaths(home));
  try {
    return { job: getJob(store.db, id), events: listEvents(store.db, id, 1000) };
  } finally {
    store.close();
  }
}

async function cli(home: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = await orchAsync(home, tmpdir(), args, env);
  if (r.code !== 0) throw new Error(`orch ${args.join(' ')} exited ${String(r.code)}: ${r.err}`);
  return r;
}

async function created(home: string, repo: string, env: NodeJS.ProcessEnv, title = 'Mail me') {
  const r = await orchAsync(
    home,
    repo,
    ['--json', 'job', 'create', '--title', title, '--description', 'Test request'],
    env,
  );
  expect(r.code, r.err).toBe(0);
  return (JSON.parse(r.out) as { jobId: string }).jobId;
}

async function claimed(home: string, id: string, env: NodeJS.ProcessEnv) {
  const r = await cli(home, ['--json', 'job', 'claim', id, '--session', 'mail-test'], env);
  return { ...env, ORCH_TOKEN: (JSON.parse(r.out) as { token: string }).token };
}

describe('job status mail through the CLI', () => {
  it('sends nothing and leaves mail columns null when mail is not configured', async () => {
    const home = tempDir('orch-mail-home-');
    const before = smtp.messages.length;
    const id = await created(home, makeRepo(), {});
    const env = await claimed(home, id, {});
    await cli(home, ['job', 'transition', id, 'start'], env);
    const { job, events } = inspect(home, id);
    expect(job).toMatchObject({
      mailCursor: null,
      mailThreadId: null,
      mailSubject: null,
      mailLastId: null,
    });
    expect(events.some((e) => e.type.startsWith('mail.'))).toBe(false);
    expect(smtp.messages.length).toBe(before);
  });

  it('mails nothing for creation, stage changes, or resume', async () => {
    const home = tempDir('orch-mail-home-');
    const base = smtp.messages.length;
    const id = await created(home, makeRepo(), mailEnv());
    const env = await claimed(home, id, mailEnv());
    await cli(home, ['job', 'transition', id, 'start'], env);
    for (const rel of ['spec.md', 'spec-review-1.md']) {
      writeArtifact(jobArtifactDir(id, homePaths(home)), rel);
      await cli(home, ['job', 'artifact', 'add', id, rel], env);
    }
    await cli(home, ['job', 'transition', id, 'complete'], env);
    await cli(home, ['job', 'transition', id, 'start'], env);
    await cli(home, ['job', 'transition', id, 'fail', '--reason', 'tests broke in CI'], env);
    await cli(home, ['job', 'transition', id, 'resume'], env);
    const { job, events } = inspect(home, id);
    for (const t of [
      'job.created',
      'stage.started',
      'stage.completed',
      'stage.failed',
      'job.resumed',
    ])
      expect(events.some((e) => e.type === t)).toBe(true);
    expect(events.some((e) => e.type.startsWith('mail.'))).toBe(false);
    expect(job).toMatchObject({ mailCursor: null, mailThreadId: null, mailLastId: null });
    expect(smtp.messages.length).toBe(base);
  });

  it('mails each reported change once, in one thread per job', async () => {
    const home = tempDir('orch-mail-home-');
    const base = smtp.messages.length;
    const sent = () => smtp.messages.slice(base);

    const id = await created(home, makeRepo(), mailEnv());
    const env = await claimed(home, id, mailEnv());
    await cli(home, ['job', 'transition', id, 'start'], env);
    expect(sent()).toHaveLength(0);
    await cli(home, ['job', 'transition', id, 'escalate', '--reason', 'needs a decision'], env);
    expect(sent()).toHaveLength(1);
    await cli(home, ['job', 'transition', id, 'cancel', '--reason', 'not needed'], env);
    const mails = sent();
    expect(mails).toHaveLength(2);

    const [first, ...later] = mails;
    const firstId = first?.headers['message-id'] ?? '';
    expect(first?.headers['subject']).toBe(`[orch] ${id}: Mail me`);
    expect(first?.headers['in-reply-to']).toBeUndefined();
    expect(first?.body).toContain('job.blocked');
    expect(first?.body).toContain('reason: needs a decision');
    later.forEach((m, i) => {
      expect(m.headers['subject']).toBe(first?.headers['subject']);
      expect(m.headers['in-reply-to']).toBe(mails[i]?.headers['message-id']);
      expect(m.headers['references']?.split(' ')[0]).toBe(firstId);
    });

    // The cancel mail says where the job is now and why.
    const cancel = mails[1]?.body ?? '';
    expect(cancel).toContain(`Job:    ${id}`);
    expect(cancel.split(/\r?\n/)[0]).toBe('\u{1F6AB} cancelled at needs-human');
    expect(cancel).toContain('job.cancelled');
    expect(cancel).toContain('reason: not needed');
    expect(cancel).not.toContain('Merged:');
    expect(cancel).toContain(`orch factory status ${id}`);

    const { job, events } = inspect(home, id);
    const sentEvents = events.filter((e) => e.type === 'mail.sent');
    expect(sentEvents.map((e) => e.payload['messageId'])).toEqual(
      mails.map((m) => m.headers['message-id']),
    );
    expect(job.mailThreadId).toBe(firstId);
    expect(job.mailLastId).toBe(mails[1]?.headers['message-id']);
    expect(job.mailSubject).toBe(`${id}: Mail me`);
    expect(job.mailCursor).toBe(
      Math.max(...events.filter((e) => e.type === 'job.cancelled').map((e) => e.id)),
    );
  });

  it('records a failed send once and leaves the command, its output, and its state alone', async () => {
    const home = tempDir('orch-mail-home-');
    const down = await fakeSmtp();
    const downEnv = mailEnv(down);
    await down.close(); // nothing listens on its port any more
    const id = await created(home, makeRepo(), {});
    const env = await claimed(home, id, downEnv);

    await cli(home, ['job', 'transition', id, 'start'], env); // not mailed
    const r = await cli(home, ['job', 'transition', id, 'escalate', '--reason', 'decide'], env);
    // stdout is the command's own output (the job's mail columns are part of every job print).
    expect(r.out).not.toMatch(/mail report|Mail to/);
    expect(r.out).toMatch(/^status\s+blocked$/m);
    const lines = r.err.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^orch: mail report for ${id} failed: Mail to 127`));
    const after = inspect(home, id);
    expect(after.job).toMatchObject({
      stage: 'needs-human',
      status: 'blocked',
      mailThreadId: null,
    });
    const failures = () => inspect(home, id).events.filter((e) => e.type === 'mail.failed');
    expect(failures()).toHaveLength(1);
    expect(String(failures()[0]?.payload['error'])).toContain('Mail to 127.0.0.1');

    // AUTH refused: --json prints nothing extra; the password is never stored or printed.
    const refusing = await fakeSmtp({ rejectAuth: true });
    try {
      const fail = await cli(home, ['--json', 'job', 'transition', id, 'cancel', '--reason', 'x'], {
        ...env,
        ...mailEnv(refusing),
      });
      expect(fail.err).toBe('');
      expect(JSON.parse(fail.out)).toMatchObject({ jobId: id, status: 'cancelled' });
      expect(fail.out).not.toContain(PASSWORD);
      expect(failures()).toHaveLength(2);
      expect(String(failures()[1]?.payload['error'])).toContain('AUTH refused: 535');
      expect(JSON.stringify(inspect(home, id).events)).not.toContain(PASSWORD);

      // A later command with no reported events neither sends nor retries.
      const show = await cli(home, ['job', 'show', id], { ...env, ...mailEnv(refusing) });
      expect(show.err).toBe('');
      expect(failures()).toHaveLength(2);
      expect(refusing.messages).toHaveLength(0);
    } finally {
      await refusing.close();
    }
  });
});

describe('mail state is metadata, claimed at most once', () => {
  it('records an outcome without touching revision or updatedAt', () => {
    const store = tempStore();
    try {
      const job = createJob(store, {
        title: 'Meta',
        description: 'd',
        repo: 'r',
        repoPath: tempDir(),
        baseBranch: 'main',
      });
      const mark = maxEventId(store.db);
      expect(claimMailCursor(store, job.id, null, mark)).toBe(true);
      expect(claimMailCursor(store, job.id, null, mark)).toBe(false);
      recordMailOutcome(store, job.id, {
        sent: true,
        messageId: '<a@example.test>',
        subject: 's',
        inReplyTo: null,
      });
      recordMailOutcome(store, job.id, { sent: false, error: 'boom' });
      const after = getJob(store.db, job.id);
      expect(after.revision).toBe(job.revision);
      expect(after.updatedAt).toBe(job.updatedAt);
      expect(after).toMatchObject({ mailCursor: mark, mailThreadId: '<a@example.test>' });
      expect(listEvents(store.db, job.id).map((e) => e.type)).toEqual([
        'job.created',
        'models.drawn',
        'mail.sent',
        'mail.failed',
      ]);
    } finally {
      store.cleanup();
    }
  });

  it('sends one mail when two reports race on the same job and watermark', async () => {
    const store = tempStore();
    try {
      const mark = maxEventId(store.db);
      const job = createJob(store, {
        title: 'Race',
        description: 'd',
        repo: 'r',
        repoPath: tempDir(),
        baseBranch: 'main',
      });
      const { token } = claimJob(store, job.id, { session: 'race' });
      transitionJob(store, job.id, 'cancel', { token, reason: 'race' });
      const before = smtp.messages.length;
      const env = smtp.env();
      const [a, b] = await Promise.all([
        reportJobMail(store, mark, env),
        reportJobMail(store, mark, env),
      ]);
      expect([...a, ...b]).toHaveLength(1);
      expect(smtp.messages.length - before).toBe(1);
      expect(listEvents(store.db, job.id).filter((e) => e.type === 'mail.sent')).toHaveLength(1);
    } finally {
      store.cleanup();
    }
  });
});

describe('dashboard actions', () => {
  it('mails a dashboard cancel into the job thread', async () => {
    const store = tempStore();
    const server = await startServer({ store, port: 0, webRoot: tempDir('orch-web-') });
    Object.assign(process.env, smtp.env());
    try {
      const job = createJob(store, {
        title: 'Dash',
        description: 'd',
        repo: 'r',
        repoPath: tempDir(),
        baseBranch: 'main',
      });
      expect(await reportJobMail(store, 0)).toEqual([]); // job.created is not mailed
      const before = smtp.messages.length;
      const headers = {
        Origin: `http://127.0.0.1:${String(server.port)}`,
        'Content-Type': 'application/json',
      };
      const url = (p: string) => new URL(p, server.url);
      const { csrf } = (await (
        await fetch(url('/api/session'), { headers })
      ).json()) as SessionInfo;
      const res = await fetch(url(`/api/jobs/${job.id}/actions`), {
        method: 'POST',
        headers: { ...headers, 'X-Orch-Csrf': csrf },
        body: JSON.stringify({ action: 'cancel', reason: 'not needed' }),
      });
      expect(res.status).toBe(200);
      const mail = (await smtp.waitFor(before + 1))[before];
      expect(mail?.headers['in-reply-to']).toBeUndefined(); // the thread starts here
      expect(mail?.body).toContain('job.cancelled');
      expect(mail?.body).toContain('reason: dashboard: not needed');
    } finally {
      for (const k of Object.keys(smtp.env())) Reflect.deleteProperty(process.env, k);
      await server.close();
      store.cleanup();
    }
  });
});
