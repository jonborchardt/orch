# Mail reports use a built-in SMTP client, sent at most once

**Decision.** Job status mail and `orch mail report` send through a small SMTP client of our own in
`src/integrations/mail.ts`, built on `node:tls`: implicit TLS with certificate verification, EHLO,
AUTH PLAIN or LOGIN, one base64 UTF-8 `text/plain` part, threading headers, no retry. Settings come
from `<config>/mail.env` parsed with `node:util` `parseEnv`, overridden by `MAIL_*` variables. A
job's batch is claimed (its `mailCursor` advanced in one immediate transaction) before the send,
and the outcome is recorded as `mail.sent` or `mail.failed`; there is no outbox and no retry.

**Why.**

- No `nodemailer`: implicit TLS, AUTH, and one text part are about 150 lines, and CLAUDE.md allows
  only `drizzle-orm` at runtime unless a built-in or a few lines cannot do the job.
- No `dotenv` or `tsx`: `parseEnv` reads the settings file, and Node strips types natively.
- At most once, no outbox: the user asked to be told, not for guaranteed delivery. Claiming first
  means a crash or a refused send loses one mail instead of sending duplicates, and a mail problem
  never fails, blocks, or rolls back a workflow write. Mail state is metadata (no revision bump) so
  it never disturbs an owner's optimistic concurrency.

**Limits.** No STARTTLS (port 587), so providers that require it (for example Office 365) need
that added first; it must never fall back to plaintext. Hand-written SMTP may miss provider quirks.
A failure after the server accepted the data leaves the outcome unknown. Add an outbox if mails
must survive crashes or be retried.
