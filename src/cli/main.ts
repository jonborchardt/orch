#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { packageInfo } from '../core/paths.ts';
import { formatChecks, runDoctor } from './doctor.ts';

const HELP = `Usage: orch [options] <command>

Commands:
  doctor         Check the local environment (Node, Git, Claude Code, paths)

Options:
  -h, --help     Show this help
  -v, --version  Show version
`;

export function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
      allowPositionals: true,
    });
  } catch (err) {
    console.error((err as Error).message);
    console.error(HELP);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(packageInfo().version);
    return 0;
  }
  const [command] = positionals;
  if (values.help || command === undefined) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }

  switch (command) {
    case 'doctor': {
      const checks = runDoctor();
      console.log(formatChecks(checks));
      return checks.some((c) => c.status === 'fail') ? 1 : 0;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
