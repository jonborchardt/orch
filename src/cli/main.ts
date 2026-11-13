#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { packageInfo } from '../core/paths.ts';
import { openStore } from '../storage/client.ts';
import { formatChecks, runDoctor } from './doctor.ts';
import { runInstall } from './install.ts';
import { JOB_HELP, runJob } from './job.ts';
import { print, printError, UsageError } from './output.ts';

const HELP = `Usage: orch [--json] <command>

Commands:
  doctor                 Check the local environment (Node, Git, Claude Code, paths)
  job <subcommand>       Create, inspect, claim, and advance factory jobs (orch job --help)
  install [--dry-run]    Link skills/ and agents/ into ~/.claude (--claude-dir, --source)

Options:
  -h, --help             Show this help
  -v, --version          Show version
      --json             Machine-readable output (errors go to stderr as JSON)

orch is a one-shot CLI: it opens the shared SQLite database, performs one deterministic
operation, prints the result, and exits. It runs no background work.
`;

const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;

export function main(argv: string[]): number {
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
        artifact: str,
        summary: str,
        url: str,
        state: str,
        status: str,
        stage: str,
        limit: str,
        // install
        'dry-run': bool,
        'claude-dir': str,
        source: str,
      },
    });
  } catch (err) {
    return printError(new UsageError(`${(err as Error).message}\n\n${HELP}`), false);
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
      console.log(command === 'job' ? JOB_HELP : HELP);
      return o.help ? 0 : 2;
    }

    switch (command) {
      case 'doctor': {
        const checks = runDoctor();
        print(json ? checks : formatChecks(checks), json);
        return checks.some((c) => c.status === 'fail') ? 1 : 0;
      }
      case 'job': {
        const store = openStore();
        try {
          print(runJob(store, rest, o), json);
        } finally {
          store.close();
        }
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

function formatInstall(r: ReturnType<typeof runInstall>): string {
  const lines = [`${r.dryRun ? 'Would link' : 'Linking'} ${r.source} -> ${r.claudeDir}`];
  if (r.entries.length === 0) lines.push('(no skills/ or agents/ found in source)');
  for (const e of r.entries) {
    const how = e.method ? ` [${e.method}]` : '';
    lines.push(
      `${e.state.toUpperCase().padEnd(8)} ${e.kind} ${e.name}${how} -> ${e.target}${e.detail ? `: ${e.detail}` : ''}`,
    );
  }
  return lines.join('\n');
}

process.exitCode = main(process.argv.slice(2));
