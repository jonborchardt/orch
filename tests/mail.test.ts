/**
 * The generic mail capability: `sendReport` against the in-process fake SMTPS server, `mailConfig`
 * with explicit inputs, and `orch mail report` through the CLI. Nothing reaches the network.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MailError, ValidationError } from '../src/core/errors.ts';
import { dotStuff, mailConfig, sendReport } from '../src/integrations/mail.ts';
import { orchAsync, tempDir } from './helpers.ts';
import {
  decodeHeader,
  type FakeSmtp,
  fakeSmtp,
  FIXTURE_CERT,
  PASSWORD,
  TO,
  USER,
} from './mail-server.ts';

let smtp: FakeSmtp;
beforeAll(async () => {
  smtp = await fakeSmtp();
});
afterAll(async () => {
  await smtp.close();
});

const ID = /^<[0-9a-f-]{36}@example\.test>$/;

describe('sendReport', () => {
  it('delivers one prefixed, base64 UTF-8 report with AUTH PLAIN and its own Message-ID', async () => {
    const text = 'Status: grün ✓\n.leading dot\n..two dots\n.\nend\n';
    const r = await sendReport(smtp.config(), { subject: 'Nightly', text });
    expect(r.messageId).toMatch(ID);
    expect(r.response).toContain('250');
    const m = smtp.messages.at(-1);
    expect(m?.auth).toEqual({ user: USER, password: PASSWORD });
    expect(m?.from).toBe(USER);
    expect(m?.to).toBe(TO);
    expect(m?.headers).toMatchObject({
      from: USER,
      to: TO,
      subject: '[orch] Nightly',
      'message-id': r.messageId,
      'content-type': 'text/plain; charset=utf-8',
      'content-transfer-encoding': 'base64',
    });
    expect(m?.headers['in-reply-to']).toBeUndefined();
    expect(m?.headers['references']).toBeUndefined();
    // Canonical CRLF line ends; otherwise the decoded body is the input, non-ASCII included.
    expect(m?.body).toBe(text.replace(/\n/g, '\r\n'));
  });

  it('dot-stuffs every line that starts with a dot', () => {
    expect(dotStuff('a\r\n.b\r\n..c\r\n.')).toBe('a\r\n..b\r\n...c\r\n..');
  });

  it('threads with In-Reply-To and References, and encodes a non-ASCII subject', async () => {
    const first = '<first@example.test>';
    const prev = '<prev@example.test>';
    await sendReport(smtp.config(), {
      subject: 'Bericht für Jörg – ünïcödé ✓ and a fairly long tail to force folding',
      text: 'x',
      inReplyTo: prev,
      references: [first, prev],
    });
    const m = smtp.messages.at(-1);
    expect(m?.headers['in-reply-to']).toBe(prev);
    expect(m?.headers['references']).toBe(`${first} ${prev}`);
    expect(m?.headers['subject']).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeHeader(m?.headers['subject'] ?? '')).toBe(
      '[orch] Bericht für Jörg – ünïcödé ✓ and a fairly long tail to force folding',
    );
  });

  it('falls back to AUTH LOGIN when that is all the server offers', async () => {
    const login = await fakeSmtp({ loginOnly: true });
    try {
      await sendReport(login.config(), { subject: 'Hi', text: 'x' });
      expect(login.messages[0]?.auth).toEqual({ user: USER, password: PASSWORD });
    } finally {
      await login.close();
    }
  });

  it('rejects bad input before connecting', async () => {
    const cfg = smtp.config({ port: 1 }); // nothing listens: only validation can answer
    const bad = [
      { subject: '  ', text: 'x' },
      { subject: 'ok', text: ' \n' },
      { subject: 'two\nlines', text: 'x' },
      { subject: 'cr\rhere', text: 'x' },
      { subject: 'ok', text: 'x', inReplyTo: 'no-brackets@example.test' },
      { subject: 'ok', text: 'x', inReplyTo: '<ok@example.test>', references: ['<bad>'] },
    ];
    for (const report of bad) {
      await expect(sendReport(cfg, report)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('throws on refused AUTH, a refused recipient, silence, and an untrusted certificate', async () => {
    const cases: [Parameters<typeof fakeSmtp>[0], RegExp][] = [
      [{ rejectAuth: true }, /AUTH refused: 535/],
      [{ rejectRcpt: true }, /RCPT TO refused: 550/],
      [{ silent: true }, /no answer within 300 ms/],
      [{ untrusted: true }, /certificate/i],
    ];
    for (const [opts, message] of cases) {
      const s = await fakeSmtp(opts);
      try {
        const err = await sendReport(s.config({ timeoutMs: opts?.silent ? 300 : 20_000 }), {
          subject: 'Hi',
          text: 'x',
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MailError);
        expect((err as Error).message).toMatch(message);
        expect((err as Error).message).not.toContain(PASSWORD);
        expect(s.messages).toHaveLength(0);
      } finally {
        await s.close();
      }
    }
  });
});

describe('mailConfig', () => {
  const full = {
    MAIL_SMTP_HOST: 'smtp.example.test',
    MAIL_USER: USER,
    MAIL_PASSWORD: PASSWORD,
    MAIL_TO: TO,
  };

  it('is null with nothing set, and reads defaults from mail.env', () => {
    const dir = tempDir();
    expect(mailConfig({}, dir)).toBeNull();
    expect(mailConfig({ MAIL_SUBJECT_PREFIX: '[x]', MAIL_SMTP_PORT: '1' }, dir)).toBeNull();
    writeFileSync(
      join(dir, 'mail.env'),
      Object.entries(full)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n# a comment\n',
    );
    expect(mailConfig({}, dir)).toEqual({
      host: 'smtp.example.test',
      port: 465,
      user: USER,
      password: PASSWORD,
      from: USER,
      to: TO,
      subjectPrefix: '[orch]',
    });
  });

  it('lets the environment override the file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'mail.env'), 'MAIL_SMTP_HOST=file.example.test\nMAIL_USER=file@x\n');
    const cfg = mailConfig(
      {
        MAIL_SMTP_HOST: 'env.example.test',
        MAIL_PASSWORD: 'p',
        MAIL_TO: TO,
        MAIL_FROM: 'Bot <bot@env.test>',
        MAIL_SMTP_PORT: '2465',
        MAIL_SUBJECT_PREFIX: '[dev]',
      },
      dir,
    );
    expect(cfg).toMatchObject({
      host: 'env.example.test',
      user: 'file@x',
      from: 'Bot <bot@env.test>',
      port: 2465,
      subjectPrefix: '[dev]',
    });
  });

  it('names the missing keys when partly configured, and rejects a bad port', () => {
    const dir = tempDir();
    const partial = () => mailConfig({ MAIL_SMTP_HOST: 'h', MAIL_PASSWORD: PASSWORD }, dir);
    expect(partial).toThrow(ValidationError);
    expect(partial).toThrow(/missing MAIL_USER, MAIL_TO/);
    try {
      partial();
    } catch (err) {
      expect((err as Error).message).not.toContain(PASSWORD);
    }
    for (const port of ['0', '70000', 'abc', '46.5']) {
      expect(() => mailConfig({ ...full, MAIL_SMTP_PORT: port }, dir)).toThrow(/MAIL_SMTP_PORT/);
    }
    expect(() => mailConfig({ ...full, MAIL_TO: 'a@b\r\nBcc: c@d' }, dir)).toThrow(/MAIL_TO/);
  });
});

describe('orch mail report', () => {
  const home = () => tempDir('orch-mail-home-');
  const textFile = () => {
    const f = join(tempDir(), 'report.txt');
    writeFileSync(f, 'All green.\n');
    return f;
  };
  const env = () => ({ ...smtp.env(), NODE_EXTRA_CA_CERTS: FIXTURE_CERT });
  const noSecret = (r: { out: string; err: string }) => {
    expect(r.out + r.err).not.toContain(PASSWORD);
  };

  it('sends, prints SENT <id>, and threads with --reply-to', async () => {
    const h = home();
    const f = textFile();
    const first = await orchAsync(h, tmpdir(), ['mail', 'report', 'Hi', '--text-file', f], env());
    expect(first.code, first.err).toBe(0);
    const id = /^SENT (<[^>]+>)$/m.exec(first.out)?.[1];
    expect(smtp.messages.at(-1)?.headers['message-id']).toBe(id);
    expect(smtp.messages.at(-1)?.headers['subject']).toBe('[orch] Hi');
    expect(smtp.messages.at(-1)?.headers['in-reply-to']).toBeUndefined();
    noSecret(first);

    const reply = await orchAsync(
      h,
      tmpdir(),
      ['--json', 'mail', 'report', 'Hi', '--text-file', f, '--reply-to', id ?? ''],
      env(),
    );
    expect(reply.code, reply.err).toBe(0);
    const receipt = JSON.parse(reply.out) as { messageId: string; response: string };
    expect(smtp.messages.at(-1)?.headers['message-id']).toBe(receipt.messageId);
    expect(smtp.messages.at(-1)?.headers['in-reply-to']).toBe(id);
    noSecret(reply);
  });

  it('exits 1 unconfigured or refused, 2 on usage mistakes, and never prints the password', async () => {
    const h = home();
    const f = textFile();
    const unconfigured = await orchAsync(h, tmpdir(), ['mail', 'report', 'Hi', '--text-file', f]);
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.err).toContain('Mail is not configured');

    const partial = await orchAsync(h, tmpdir(), ['mail', 'report', 'Hi', '--text-file', f], {
      MAIL_SMTP_HOST: '127.0.0.1',
      MAIL_PASSWORD: PASSWORD,
    });
    expect(partial.code).toBe(1);
    noSecret(partial);

    const refused = await fakeSmtp({ rejectAuth: true });
    try {
      const r = await orchAsync(h, tmpdir(), ['mail', 'report', 'Hi', '--text-file', f], {
        ...refused.env(),
        NODE_EXTRA_CA_CERTS: FIXTURE_CERT,
      });
      expect(r.code).toBe(1);
      expect(r.err).toContain('MailError');
      noSecret(r);
    } finally {
      await refused.close();
    }

    for (const args of [
      ['mail', 'report', 'Hi'],
      ['mail', 'report', 'Hi', '--text-file', f, '--to', 'evil@example.test'],
      ['mail', 'report', '--text-file', f],
      ['mail', 'send', 'Hi', '--text-file', f],
    ]) {
      const r = await orchAsync(h, tmpdir(), args, env());
      expect(r.code, args.join(' ')).toBe(2);
      noSecret(r);
    }
  });
});
