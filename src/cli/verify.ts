/** `orch verify ...` handlers: run the repository's verification policy and read the evidence. */
import { showVerification, verifyJob } from '../ops/verify.ts';
import type { Store } from '../storage/client.ts';
import { UsageError } from './output.ts';

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
    if (!second) throw new UsageError(`Missing required <job-id>\n\n${VERIFY_HELP}`);
    const status = showVerification(store, second);
    return { result: status ?? { configured: false, reason: 'job has no worktree' }, exitCode: 0 };
  }
  if (second !== undefined)
    throw new UsageError(`Unexpected argument: ${second}\n\n${VERIFY_HELP}`);
  let expectRevision: number | undefined;
  if (o.revision !== undefined) {
    expectRevision = Number(o.revision);
    if (!Number.isInteger(expectRevision) || expectRevision < 0) {
      throw new UsageError('--revision must be a non-negative integer');
    }
  }
  const result = verifyJob(store, first, { token: o.token ?? env['ORCH_TOKEN'], expectRevision });
  return { result, exitCode: result.status === 'passed' ? 0 : 1 };
}
