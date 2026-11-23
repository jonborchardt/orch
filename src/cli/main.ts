#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { UsageError } from '../core/errors.ts';
import { runtimePaths } from '../core/paths.ts';
import { packageInfo } from '../core/paths.ts';
import { openStore, type Store } from '../storage/client.ts';
import { BACKUP_HELP, runBackup } from './backup.ts';
import { CHECKOUT_HELP, runCheckout } from './checkout.ts';
import { formatChecks, runDoctor } from './doctor.ts';
import { FACTORY_HELP, runFactory } from './factory.ts';
import { GH_HELP, runGh } from './gh.ts';
import { formatInit, INIT_HELP, runInit } from './init.ts';
import { formatInstall, runInstall } from './install.ts';
import { formatMerge, JOB_HELP, mergeExitCode, runJob } from './job.ts';
import { MAIL_HELP, runMail } from './mail.ts';
import { formatFactoryList, formatPlan, print, printError } from './output.ts';
import type { HookOutcome } from '../ops/checkout.ts';
import type { FactoryRow } from '../ops/dispatch.ts';
import type { Plan } from '../ops/factory.ts';
import type { MergeResult } from '../ops/merge.ts';
import type { TicketList } from '../ops/tickets.ts';
import { mailWatermark, reportJobMail } from '../ops/mail.ts';
import { RECOVER_HELP, runRecover } from './recover.ts';
import { formatTicketList, runTicket, TICKET_HELP } from './ticket.ts';
import { RUN_COMMANDS, RUN_HELP, runRunner } from './run.ts';
import { runUi, UI_HELP } from './ui.ts';
import { runVerify, VERIFY_HELP } from './verify.ts';
import { runWorktree, WORKTREE_HELP } from './worktree.ts';

const HELP = `Usage: orch [--json] <command>

Typical workflow:
  orch init --check          Check the repository's factory.json is committed and runnable
  /factory <request>         In Claude Code (a skill, not an orch command): build a request as a job
  orch factory list          Every job with its state, owner, and attention needed
  orch factory status <id>   One job's current step, agents, artifacts, and commands (read-only)
  orch ui                    Watch jobs in the local dashboard
  orch start                 Work the ticket queue unattended: run, verify, merge, next ticket

Commands:
  start [repo]           Run the factory controller in the foreground: take ready tickets (of
                         every repository, or only this one), run each job with /factory in a
                         headless Claude Code session, merge verified work, continue
  do <ticket-id>         The same for exactly one ticket
  stop [next]            Stop the controller now (the job is kept, never cancelled), or with
                         next: after the current ticket
  status                 The controller, its ticket and job, and what happens next
  resume                 Continue an interrupted controller session (orch start --help)
  factory <subcommand>   The primary interface: start, plan, resume, dispatch, and list factory
                         jobs for the /factory skill (orch factory --help)
  ticket <subcommand>    The global ticket queue: add, list, ready, show, edit, start, done,
                         dependencies, import (orch ticket --help)
  doctor                 Check the local environment (Node, Git, Claude Code, paths)
  init                   Write a repository's factory.json verification policy, or --check its
                         readiness (orch init --help)
  install [--dry-run]    Link skills/, .claude/skills/, and agents/ into ~/.claude
                         (--claude-dir, --source)
  ui [--port <n>] [--open]
                         Serve the local dashboard on loopback (long-running, optional)
  recover start|stop|status|run [--once]
                         Opt-in worker that continues ci-stage jobs after a network outage
                         (orch recover --help)
  backup create <file> | restore <file> [--data-dir <dir>]
                         Archive the database, artifacts, and ticket assets, or restore one
                         into an empty data directory (orch backup --help)

Low-level commands (used internally and by generated plans):
  job <subcommand>       Create, inspect, claim, and advance factory jobs (orch job --help)
  worktree <subcommand>  Create, inspect, adopt, remove a job's Git worktree (orch worktree --help)
  checkout <subcommand>  Which session is working in a checkout; the Claude Code hook
                         (orch checkout --help)
  gh <subcommand>        GitHub via gh: issue, push, draft PR, CI status (orch gh --help)
  verify <job-id>        Run the repository's verification policy in the job worktree
                         (orch verify --help)
  mail report <subject>  Send one plain-text report to the configured recipient
                         (orch mail --help)

Options:
  -h, --help             Show this help
  -v, --version          Show version
      --json             Machine-readable output (errors go to stderr as JSON)

orch is a one-shot CLI: it opens the shared SQLite database, performs one deterministic
operation, prints the result, and exits. The only long-running commands are orch ui, the
opt-in orch recover worker, and the factory controller (orch start, do, resume), which runs in
the foreground until its session ends; jobs never need any of them to be running.
`;

const SUBCOMMAND_HELP: Record<string, string> = {
  job: JOB_HELP,
  worktree: WORKTREE_HELP,
  checkout: CHECKOUT_HELP,
  gh: GH_HELP,
  factory: FACTORY_HELP,
  verify: VERIFY_HELP,
  init: INIT_HELP,
  ui: UI_HELP,
  recover: RECOVER_HELP,
  mail: MAIL_HELP,
  ticket: TICKET_HELP,
  backup: BACKUP_HELP,
  ...Object.fromEntries(RUN_COMMANDS.map((c) => [c, RUN_HELP])),
};

const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;

/**
 * Open the shared database for one command and close it however the command ends. Afterwards,
 * mail each job the command recorded reported events for (ops/mail.ts); a mail failure only adds
 * a stderr line in text mode and never changes the result or exit code.
 */
async function withStore<T>(json: boolean, fn: (store: Store) => T): Promise<T> {
  const store = openStore();
  try {
    const mark = mailWatermark(store);
    try {
      return fn(store);
    } finally {
      for (const o of await reportJobMail(store, mark)) {
        if (o.error !== null && !json) {
          process.stderr.write(`orch: mail report for ${o.jobId} failed: ${o.error}\n`);
        }
      }
    }
  } finally {
    store.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { ...bool, short: 'h' },
        version: { ...bool, short: 'v' },
        json: bool,
        // job
        title: str,
        description: str,
        issue: str,
        repo: str,
        base: str,
        'max-rounds': str,
        session: str,
        lease: str,
        force: bool,
        token: str,
        revision: str,
        to: str,
        reason: str,
        reviewer: str,
        verdict: str,
        summary: str,
        status: str,
        stage: str,
        limit: str,
        replace: bool,
        by: str,
        // job notice
        message: str,
        through: str,
        // worktree / gh / checkout
        path: str,
        all: bool,
        'body-file': str,
        // mail
        text: str,
        'text-file': str,
        'reply-to': str,
        // factory
        ui: bool,
        'no-ui': bool,
        fingerprint: str,
        adopt: str,
        release: bool,
        // job session attach
        provider: str,
        ref: str,
        cwd: str,
        // ticket
        ticket: str,
        type: str,
        area: str,
        priority: str,
        effort: str,
        classified: str,
        'depends-on': str,
        related: str,
        body: str,
        offset: str,
        of: str,
        note: str,
        dir: str,
        // backup
        'data-dir': str,
        // ui
        port: str,
        open: bool,
        // recover
        once: bool,
        // do
        fast: bool,
        // init
        command: { type: 'string', multiple: true },
        'from-package-json': bool,
        check: bool,
        // install
        'dry-run': bool,
        'claude-dir': str,
        source: str,
      },
    });
  } catch (err) {
    return printError(
      new UsageError(`${(err as Error).message}\n\n${HELP}`),
      argv.includes('--json'),
    );
  }
  const { values: o, positionals } = parsed;
  const json = o.json ?? false;

  try {
    if (o.version) {
      console.log(packageInfo().version);
      return 0;
    }
    const [command, ...rest] = positionals;
    if (o.help || command === undefined) {
      console.log((command && SUBCOMMAND_HELP[command]) ?? HELP);
      return o.help ? 0 : 2;
    }

    switch (command) {
      case 'doctor': {
        const checks = runDoctor();
        print(json ? checks : formatChecks(checks), json);
        return checks.some((c) => c.status === 'fail') ? 1 : 0;
      }
      case 'job': {
        const result = await withStore(json, (store) => runJob(store, rest, o));
        if (rest[0] !== 'merge') {
          print(result, json);
          return 0;
        }
        const merged = result as MergeResult;
        print(json ? merged : formatMerge(merged), json);
        return mergeExitCode(merged);
      }
      case 'factory': {
        const result = await withStore(json, (store) => runFactory(store, rest, o));
        const sub = rest[0];
        print(
          json
            ? result
            : sub === 'list'
              ? formatFactoryList(result as FactoryRow[], new Date())
              : sub === 'next' || sub === 'status'
                ? formatPlan(result as Plan)
                : result,
          json,
        );
        return 0;
      }
      case 'ticket': {
        const result = await withStore(json, (store) => runTicket(store, rest, o));
        const listed = ['list', 'order', 'ready', 'blocked'].includes(rest[0] ?? '');
        print(json || !listed ? result : formatTicketList(result as TicketList), json);
        return 0;
      }
      case 'worktree':
        print(await withStore(json, (store) => runWorktree(store, rest, o)), json);
        return 0;
      case 'checkout': {
        // No database: the guard runs from any checkout and must never migrate the shared store.
        const { result, exitCode } = runCheckout(runtimePaths(), rest, o);
        if (rest[0] === 'hook' && !json) {
          const h = result as HookOutcome;
          if (h.stdout) process.stdout.write(h.stdout + '\n');
          if (h.stderr) process.stderr.write(h.stderr + '\n');
        } else {
          print(result, json);
        }
        return exitCode;
      }
      case 'gh':
        print(await withStore(json, (store) => runGh(store, rest, o)), json);
        return 0;
      case 'verify': {
        const { result, exitCode } = await withStore(json, (store) => runVerify(store, rest, o));
        print(result, json);
        return exitCode;
      }
      case 'init': {
        const result = runInit(rest, o);
        print(json ? result : formatInit(result), json);
        return 'ready' in result && !result.ready ? 1 : 0;
      }
      case 'ui':
        return await runUi(o);
      case 'start':
      case 'do':
      case 'stop':
      case 'status':
      case 'resume': {
        const { text, data, exitCode } = await runRunner(command, rest, {
          json,
          force: o.force,
          fast: o.fast,
        });
        print(json ? data : text, json);
        return exitCode;
      }
      case 'recover':
        print(await runRecover(rest, o, process.argv[1] ?? ''), json);
        return 0;
      case 'backup': {
        // No withStore: create reads the database through its own snapshot connection, and
        // restore must not create a database in the destination before it checks it is empty.
        const { data, text } = runBackup(rest, o);
        print(json ? data : text, json);
        return 0;
      }
      case 'mail': {
        // No database: a generic sender that knows nothing about jobs.
        const receipt = await runMail(rest, o);
        print(json ? receipt : `SENT ${receipt.messageId}`, json);
        return 0;
      }
      case 'install': {
        const report = runInstall(o);
        print(json ? report : formatInstall(report), json);
        return report.problems ? 1 : 0;
      }
      default:
        throw new UsageError(`Unknown command: ${command}\n\n${HELP}`);
    }
  } catch (err) {
    return printError(err, json);
  }
}

process.exitCode = await main(process.argv.slice(2));
