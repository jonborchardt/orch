/** `orch mail report`: send one plain-text report to the configured recipient. No database. */
import { readFileSync } from 'node:fs';

import { UsageError, ValidationError } from '../core/errors.ts';
import { MAIL_ENV_FILE, mailConfig, type MailReceipt, sendReport } from '../integrations/mail.ts';
import { need } from './args.ts';

export interface MailOptions {
  text?: string;
  'text-file'?: string;
  'reply-to'?: string;
  to?: string;
}

export const MAIL_HELP = `Usage: orch mail report "<subject>" (--text "<body>" | --text-file <file>) [--reply-to <message-id>]

  report          Send the body (inline, or the UTF-8 text in <file>) to MAIL_TO with the configured subject prefix and
                  print SENT <message-id>. --reply-to threads it after that earlier message (reuse
                  the same subject). There is no recipient option. Exit 0 means the SMTP server
                  accepted the mail, not that it was delivered; exit 1 means it was not confirmed,
                  and nothing is retried.

Settings (MAIL_SMTP_HOST, MAIL_SMTP_PORT (465), MAIL_USER, MAIL_PASSWORD, MAIL_FROM, MAIL_TO,
MAIL_SUBJECT_PREFIX ([orch])) come from ${MAIL_ENV_FILE} in the orch config directory; an
environment variable of the same name overrides it. Only implicit TLS (SMTPS) is supported.
`;

export async function runMail(rest: string[], o: MailOptions): Promise<MailReceipt> {
  const [sub, subject, ...extra] = rest;
  if (sub !== 'report') {
    throw new UsageError(`Unknown mail subcommand: ${sub ?? ''}\n\n${MAIL_HELP}`);
  }
  if (o.to !== undefined) {
    throw new UsageError('orch mail report has no recipient option; mail goes to MAIL_TO only.');
  }
  if (extra.length) {
    throw new UsageError(`Unexpected arguments: ${extra.join(' ')}\n\n${MAIL_HELP}`);
  }
  const title = need(subject, '<subject>', MAIL_HELP);
  if ((o.text === undefined) === (o['text-file'] === undefined)) {
    throw new UsageError(`Give exactly one of --text or --text-file.\n\n${MAIL_HELP}`);
  }
  let text = o.text ?? '';
  const file = o['text-file'];
  if (file !== undefined) {
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new ValidationError(`Cannot read --text-file ${file}: ${(err as Error).message}`);
    }
  }
  const cfg = mailConfig();
  if (cfg === null) {
    throw new ValidationError(
      `Mail is not configured: set MAIL_SMTP_HOST, MAIL_USER, MAIL_PASSWORD, and MAIL_TO in ${MAIL_ENV_FILE} in the orch config directory or the environment.`,
    );
  }
  return sendReport(cfg, { subject: title, text, inReplyTo: o['reply-to'] });
}
