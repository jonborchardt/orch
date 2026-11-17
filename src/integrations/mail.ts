/**
 * Generic one-way reporting mail (decision 2026-11-17-mail-reports-built-in-smtp-client): one
 * plain-text report to one configured recipient over SMTP with implicit TLS, optionally threaded
 * with In-Reply-To/References. Knows nothing about jobs. Never logs configuration values.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { connect, type TLSSocket } from 'node:tls';
import { parseEnv } from 'node:util';

import { MailError, ValidationError } from '../core/errors.ts';
import { runtimePaths } from '../core/paths.ts';

export interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  to: string;
  subjectPrefix: string;
  /** Trusted CA certificate (PEM) replacing the default roots. Tests only; never read from env. */
  ca?: string | undefined;
  /** Milliseconds to connect (default 10 s) and for the whole exchange (default 30 s). Tests only. */
  connectTimeoutMs?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface MailReport {
  subject: string;
  text: string;
  /** Message-ID of the mail this one follows up. */
  inReplyTo?: string | undefined;
  /** Earlier Message-IDs of the thread, oldest first; defaults to `[inReplyTo]`. */
  references?: readonly string[] | undefined;
}

export interface MailReceipt {
  messageId: string;
  /** The server's reply to the message data. */
  response: string;
}

/** File in the orch config directory holding `MAIL_*` settings (dotenv syntax). */
export const MAIL_ENV_FILE = 'mail.env';

const REQUIRED = ['MAIL_SMTP_HOST', 'MAIL_USER', 'MAIL_PASSWORD', 'MAIL_TO'] as const;
const OPTIONAL = ['MAIL_SMTP_PORT', 'MAIL_FROM', 'MAIL_SUBJECT_PREFIX'] as const;
const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

type Env = Record<string, string | undefined>;

/**
 * Mail settings from `<configDir>/mail.env`, each overridden by a non-empty environment variable
 * of the same name. Null when none of host, user, password, or recipient is set (mail is off);
 * a ValidationError naming the missing keys when only some are.
 */
export function mailConfig(
  env: Env = process.env,
  configDir: string = runtimePaths(env).config,
): MailConfig | null {
  const path = join(configDir, MAIL_ENV_FILE);
  let file: Env = {};
  try {
    file = parseEnv(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ValidationError(`Cannot read ${path}: ${(err as Error).message}`);
    }
  }
  const values: Env = {};
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    const fromEnv = env[key];
    const v = fromEnv !== undefined && fromEnv !== '' ? fromEnv : file[key];
    if (v === undefined || v === '') continue;
    if (/[\r\n]/.test(v)) throw new ValidationError(`${key} must be a single line.`);
    values[key] = v;
  }
  const missing = REQUIRED.filter((k) => values[k] === undefined);
  if (missing.length === REQUIRED.length) return null;
  if (missing.length) {
    throw new ValidationError(
      `Mail is partly configured; missing ${missing.join(', ')} (set them in ${path} or the environment).`,
    );
  }
  const port = Number(values['MAIL_SMTP_PORT'] ?? 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('MAIL_SMTP_PORT must be an integer from 1 to 65535.');
  }
  const user = values['MAIL_USER'] ?? '';
  return {
    host: values['MAIL_SMTP_HOST'] ?? '',
    port,
    user,
    password: values['MAIL_PASSWORD'] ?? '',
    from: values['MAIL_FROM'] ?? user,
    to: values['MAIL_TO'] ?? '',
    subjectPrefix: values['MAIL_SUBJECT_PREFIX'] ?? '[orch]',
  };
}

/** The bare address of `Name <a@b>` or `a@b`. */
function address(s: string): string {
  return /<([^<>]+)>/.exec(s)?.[1]?.trim() ?? s.trim();
}

/** RFC 5321 transparency: a line starting with `.` gets a second one. */
export function dotStuff(data: string): string {
  return data.replace(/^\./gm, '..');
}

/** RFC 2047 encoded words for a non-ASCII header value, folded so no line runs long. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let cur = '';
  for (const ch of value) {
    if (Buffer.byteLength(cur + ch) > 45) {
      words.push(cur);
      cur = '';
    }
    cur += ch;
  }
  words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

function buildMessage(
  cfg: MailConfig,
  subject: string,
  report: MailReport,
  messageId: string,
): string {
  const refs = report.references?.length
    ? report.references
    : report.inReplyTo
      ? [report.inReplyTo]
      : [];
  const text = report.text.replace(/\r?\n/g, '\r\n');
  const body =
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? [];
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${cfg.from}`,
    `To: ${cfg.to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${messageId}`,
    ...(report.inReplyTo ? [`In-Reply-To: ${report.inReplyTo}`] : []),
    ...(refs.length ? [`References: ${refs.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return dotStuff([...headers, '', ...body].join('\r\n'));
}

interface Reply {
  code: number;
  text: string;
}

/** Complete (possibly multi-line) SMTP replies in arrival order; rejects once the socket fails. */
function replies(socket: TLSSocket): () => Promise<Reply> {
  const ready: Reply[] = [];
  let waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  let failure: Error | null = null;
  let buf = '';
  let lines: string[] = [];
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3}-/.test(line)) continue;
      const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
      lines = [];
      if (waiting) waiting.resolve(reply);
      else ready.push(reply);
      waiting = null;
    }
  });
  const fail = (err: Error) => {
    failure ??= err;
    waiting?.reject(failure);
    waiting = null;
  };
  socket.on('error', fail);
  socket.on('close', () => {
    fail(new MailError('the server closed the connection'));
  });
  return () => {
    const r = ready.shift();
    if (r) return Promise.resolve(r);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
    });
  };
}

/**
 * Send one report: implicit TLS with certificate verification, EHLO, AUTH PLAIN (or LOGIN),
 * MAIL FROM, RCPT TO, DATA, QUIT. No retry. Throws a ValidationError for bad input (before
 * connecting) and a MailError for anything the connection or server refuses.
 */
export async function sendReport(cfg: MailConfig, report: MailReport): Promise<MailReceipt> {
  if (!report.subject.trim()) throw new ValidationError('Mail subject is blank.');
  if (/[\r\n]/.test(report.subject)) throw new ValidationError('Mail subject must be one line.');
  if (!report.text.trim()) throw new ValidationError('Mail text is blank.');
  for (const id of [report.inReplyTo, ...(report.references ?? [])]) {
    if (id !== undefined && !MESSAGE_ID.test(id)) {
      throw new ValidationError(`Not a full Message-ID (like <id@example.com>): ${id}`);
    }
  }
  const from = address(cfg.from);
  const to = address(cfg.to);
  const domain = /@([^<>\s@]+)$/.exec(from)?.[1] ?? 'localhost';
  const messageId = `<${randomUUID()}@${domain}>`;
  const subject = [cfg.subjectPrefix, report.subject].filter(Boolean).join(' ');
  const data = buildMessage(cfg, subject, report, messageId);

  const where = `${cfg.host}:${String(cfg.port)}`;
  const socket = connect({
    host: cfg.host,
    port: cfg.port,
    servername: isIP(cfg.host) ? undefined : cfg.host,
    ca: cfg.ca,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  });
  const next = replies(socket);
  const connectMs = cfg.connectTimeoutMs ?? 10_000;
  const totalMs = cfg.timeoutMs ?? 30_000;
  const connectTimer = setTimeout(() => {
    socket.destroy(new MailError(`connecting timed out after ${String(connectMs)} ms`));
  }, connectMs);
  socket.once('secureConnect', () => {
    clearTimeout(connectTimer);
  });
  const totalTimer = setTimeout(() => {
    socket.destroy(new MailError(`no answer within ${String(totalMs)} ms`));
  }, totalMs);

  const expect = async (step: string, codes: number[]): Promise<Reply> => {
    const r = await next();
    if (!codes.includes(r.code)) throw new MailError(`${step} refused: ${r.text}`);
    return r;
  };
  const command = (line: string, step: string, codes: number[]): Promise<Reply> => {
    socket.write(`${line}\r\n`);
    return expect(step, codes);
  };
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  try {
    await expect('greeting', [220]);
    const ehlo = await command('EHLO localhost', 'EHLO', [250]);
    const auth = /^250[ -]AUTH[ =](.*)$/im.exec(ehlo.text)?.[1]?.toUpperCase().split(/\s+/) ?? [];
    if (auth.includes('PLAIN')) {
      await command(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password}`)}`, 'AUTH', [235]);
    } else if (auth.includes('LOGIN')) {
      await command('AUTH LOGIN', 'AUTH', [334]);
      await command(b64(cfg.user), 'AUTH', [334]);
      await command(b64(cfg.password), 'AUTH', [235]);
    } else {
      throw new MailError('the server offers neither AUTH PLAIN nor AUTH LOGIN');
    }
    await command(`MAIL FROM:<${from}>`, 'MAIL FROM', [250]);
    await command(`RCPT TO:<${to}>`, 'RCPT TO', [250, 251]);
    await command('DATA', 'DATA', [354]);
    const accepted = await command(`${data}\r\n.`, 'message', [250]);
    await command('QUIT', 'QUIT', [221]).catch(() => undefined);
    return { messageId, response: accepted.text };
  } catch (err) {
    throw new MailError(`Mail to ${where} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    socket.destroy();
  }
}
