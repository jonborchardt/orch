/** `orch checkout ...` handlers: who is working in which checkout, and the Claude Code hook. */
import { readFileSync } from 'node:fs';

import { UsageError } from '../core/errors.ts';
import type { RuntimePaths } from '../core/paths.ts';
import {
  checkoutStatus,
  claimCheckoutAt,
  hookCheckout,
  type HookOutcome,
  listCheckouts,
  parseHookInput,
  releaseAllCheckouts,
  releaseCheckoutAt,
} from '../ops/checkout.ts';
import { int, need } from './args.ts';

export interface CheckoutOptions {
  path?: string;
  session?: string;
  lease?: string;
  force?: boolean;
  all?: boolean;
}

export const CHECKOUT_HELP = `Usage: orch checkout <command> [options]

  status [--path <p>]                       Who holds the checkout containing <p> (default: cwd)
  list                                      Every recorded checkout claim and whether its lease is live
  claim --session <s> [--path <p>] [--lease <minutes>] [--force]
                                            Claim (or renew) the checkout for a session; exit 4 while
                                            another session's lease is live, unless --force
  release --session <s> [--path <p> | --all]
                                            Give a checkout back (or everything the session holds)
  hook                                      Claude Code hook: reads the hook JSON on stdin. PreToolUse
                                            on Edit/Write claims the file's checkout and exits 2 when
                                            another live session holds it; SessionStart reports a
                                            holder; SessionEnd releases the session's claims

A checkout is identified by its Git directory, so the primary checkout and each linked worktree
are separate checkouts and two spellings of one path are the same checkout. A hook claim stays
live while the session's transcript is being written, not only while it edits. This is cooperative:
it detects two sessions sharing a checkout; it does not stop a process that writes without asking.
--session defaults to $ORCH_SESSION. State lives under <data>/checkouts/, never in a repository.
`;

export interface CheckoutOutcome {
  result: unknown;
  exitCode: number;
}

export function runCheckout(
  paths: RuntimePaths,
  args: string[],
  o: CheckoutOptions,
  env = process.env,
  stdin: () => string = () => readFileSync(0, 'utf8'),
): CheckoutOutcome {
  const [cmd] = args;
  const path = o.path ?? process.cwd();
  const session = () => need(o.session ?? env['ORCH_SESSION'], '--session <name>', CHECKOUT_HELP);
  switch (cmd) {
    case 'status':
      return { result: checkoutStatus(paths, path), exitCode: 0 };
    case 'list':
      return { result: listCheckouts(paths), exitCode: 0 };
    case 'claim':
      return {
        result: claimCheckoutAt(paths, path, session(), {
          leaseMinutes: int(o.lease, '--lease'),
          force: o.force,
        }),
        exitCode: 0,
      };
    case 'release':
      return {
        result: o.all
          ? releaseAllCheckouts(paths, session())
          : releaseCheckoutAt(paths, path, session()),
        exitCode: 0,
      };
    case 'hook': {
      const outcome: HookOutcome = hookCheckout(paths, parseHookInput(stdin()));
      return { result: outcome, exitCode: outcome.exitCode };
    }
    case undefined:
      throw new UsageError(CHECKOUT_HELP);
    default:
      throw new UsageError(`Unknown checkout command: ${cmd}\n\n${CHECKOUT_HELP}`);
  }
}
