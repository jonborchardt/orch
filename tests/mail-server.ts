/**
 * An in-process fake SMTPS server for the mail tests: node:tls with the fixture certificate under
 * tests/fixtures/mail/, on a free loopback port. It speaks just enough SMTP for `sendReport`, records
 * each accepted message (headers unfolded, body base64-decoded), and can refuse AUTH or RCPT or stay
 * silent. Nothing reaches the network. CLI tests trust it with NODE_EXTRA_CA_CERTS=FIXTURE_CERT and
 * must spawn with `orchAsync`: this server cannot answer while `spawnSync` blocks the event loop.
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';

import type { MailConfig } from '../src/integrations/mail.ts';

const dir = join(import.meta.dirname, 'fixtures', 'mail');
export const FIXTURE_CERT = join(dir, 'cert.pem');
export const CERT = readFileSync(FIXTURE_CERT, 'utf8');
const KEY = readFileSync(join(dir, 'key.pem'), 'utf8');
const UNTRUSTED = {
  cert: readFileSync(join(dir, 'untrusted-cert.pem'), 'utf8'),
  key: readFileSync(join(dir, 'untrusted-key.pem'), 'utf8'),
};

export interface Received {
  /** Raw message data as the client sent it, dot-stuffing included. */
  raw: string;
  headers: Record<string, string>;
  body: string;
  from: string;
  to: string;
  /** user and password from AUTH. */
  auth: { user: string; password: string };
}

export interface FakeSmtpOptions {
  rejectAuth?: boolean;
  rejectRcpt?: boolean;
  /** Accept the connection but never greet. */
  silent?: boolean;
  /** Advertise only AUTH LOGIN. */
  loginOnly?: boolean;
  /** Present a certificate nobody trusts. */
  untrusted?: boolean;
}

export interface FakeSmtp {
  port: number;
  messages: Received[];
  /** Resolve once `n` messages arrived (rejects after `ms`). */
  waitFor(n: number, ms?: number): Promise<Received[]>;
  /** Settings for this server; `ca` trusts the fixture certificate. */
  config(over?: Partial<MailConfig>): MailConfig;
  /** MAIL_* variables for a CLI pointed at this server. */
  env(): Record<string, string>;
  close(): Promise<void>;
}

export const USER = 'bot@example.test';
export const PASSWORD = 'pa55-SECRET-word';
export const TO = 'owner@example.test';

/** Decode RFC 2047 `=?UTF-8?B?...?=` words (what `sendReport` writes for non-ASCII subjects). */
export function decodeHeader(v: string): string {
  return v
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b: string) =>
      Buffer.from(b, 'base64').toString('utf8'),
    );
}

function parse(raw: string): Pick<Received, 'headers' | 'body'> {
  const unstuffed = raw.replace(/^\.\./gm, '.');
  const split = unstuffed.indexOf('\r\n\r\n');
  const head = unstuffed.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const headers: Record<string, string> = {};
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const body = Buffer.from(unstuffed.slice(split + 4).replace(/\s+/g, ''), 'base64').toString(
    'utf8',
  );
  return { headers, body };
}

export async function fakeSmtp(opts: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const messages: Received[] = [];
  const waiters: (() => void)[] = [];
  const sockets = new Set<TLSSocket>();
  const server = createServer(opts.untrusted ? UNTRUSTED : { cert: CERT, key: KEY }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    const say = (line: string) => socket.write(`${line}\r\n`);
    let buf = '';
    let data: string[] | null = null;
    let login: 'user' | 'password' | null = null;
    let auth = { user: '', password: '' };
    let from = '';
    let to = '';
    const b64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
    const authed = () => {
      say(opts.rejectAuth ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 OK');
    };
    const onLine = (line: string) => {
      if (data !== null) {
        if (line !== '.') {
          data.push(line);
          return;
        }
        const raw = data.join('\r\n');
        data = null;
        messages.push({ raw, ...parse(raw), from, to, auth });
        say('250 2.0.0 OK queued as fake');
        for (const w of waiters.splice(0)) w();
        return;
      }
      if (login === 'user') {
        auth = { ...auth, user: b64(line) };
        login = 'password';
        say('334 UGFzc3dvcmQ6');
        return;
      }
      if (login === 'password') {
        auth = { ...auth, password: b64(line) };
        login = null;
        authed();
        return;
      }
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO') {
        say('250-fake.example.test');
        say('250-SIZE 1000000');
        say(`250 AUTH ${opts.loginOnly ? 'LOGIN' : 'PLAIN LOGIN'}`);
      } else if (line.toUpperCase().startsWith('AUTH PLAIN ')) {
        const [, user = '', password = ''] = b64(line.slice(11)).split('\0');
        auth = { user, password };
        authed();
      } else if (line.toUpperCase() === 'AUTH LOGIN') {
        login = 'user';
        say('334 VXNlcm5hbWU6');
      } else if (verb === 'MAIL') {
        from = /<([^>]*)>/.exec(line)?.[1] ?? '';
        say('250 2.1.0 OK');
      } else if (verb === 'RCPT') {
        to = /<([^>]*)>/.exec(line)?.[1] ?? '';
        say(opts.rejectRcpt ? '550 5.1.1 No such user' : '250 2.1.5 OK');
      } else if (verb === 'DATA') {
        data = [];
        say('354 Go ahead');
      } else if (verb === 'QUIT') {
        say('221 2.0.0 Bye');
        socket.end();
      } else {
        say('502 5.5.2 Unknown command');
      }
    };
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    });
    if (!opts.silent) say('220 fake.example.test ESMTP ready');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    messages,
    waitFor: (n, ms = 20_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`expected ${String(n)} mails, got ${String(messages.length)}`));
        }, ms);
        const check = () => {
          if (messages.length >= n) {
            clearTimeout(timer);
            resolve(messages);
          } else waiters.push(check);
        };
        check();
      }),
    config: (over = {}) => ({
      host: '127.0.0.1',
      port,
      user: USER,
      password: PASSWORD,
      from: USER,
      to: TO,
      subjectPrefix: '[orch]',
      ca: CERT,
      ...over,
    }),
    env: () => ({
      MAIL_SMTP_HOST: '127.0.0.1',
      MAIL_SMTP_PORT: String(port),
      MAIL_USER: USER,
      MAIL_PASSWORD: PASSWORD,
      MAIL_TO: TO,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
