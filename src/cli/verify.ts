/** `orch verify ...` handlers: run the repository's verification policy and read the evidence. */
import { UsageError } from '../core/errors.ts';
import { showVerification, verifyJob } from '../ops/verify.ts';
import type { Store } from '../storage/client.ts';
import { authFrom, need } from './args.ts';

export interface VerifyOptions {
  token?: string;
  revision?: string;
}

export const VERIFY_HELP = `Usage: orch verify <job-id> [--token <t>]
       orch verify show <job-id>

  <job-id>        Run every verification command from the effective policy (factory.json at the
                  merge base, or the policy a human accepted) inside the job's clean worktree,
                  in order, stopping at the first failed required check. Records the run, each
                  check (command, cwd, exit code, duration, output log and hash), the commit, and
                  the policy fingerprint. Exit 1 when a required check fails or no policy exists.
                  When the latest run passed and is still valid for this clean HEAD and policy,
                  it is returned as is (reused: true) and nothing runs.
  show <job-id>   The latest run and whether it is still valid for HEAD (read-only).

Verification never runs in the initiating checkout, never runs commands from job text, and
refuses a worktree with uncommitted changes.
`;

export interface VerifyOutcome {
  result: unknown;
  exitCode: number;
}

export function runVerify(
  store: Store,
  args: string[],
  o: VerifyOptions,
  env = process.env,
): VerifyOutcome {
  const [first, second] = args;
  if (first === undefined) throw new UsageError(VERIFY_HELP);
  if (first === 'show') {
    const status = showVerification(store, need(second, '<job-id>', VERIFY_HELP));
    return { result: status ?? { configured: false, reason: 'job has no worktree' }, exitCode: 0 };
  }
  if (second !== undefined)
    throw new UsageError(`Unexpected argument: ${second}\n\n${VERIFY_HELP}`);
  const result = verifyJob(store, first, authFrom(o, env), {
    onWait: (message) => process.stderr.write(message + '\n'),
  });
  return { result, exitCode: result.status === 'passed' ? 0 : 1 };
}
