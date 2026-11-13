/** `orch worktree ...` handlers. */
import {
  adoptWorktree,
  createWorktree,
  dropWorktree,
  integrateBase,
  showWorktree,
} from '../ops/worktree.ts';
import type { Store } from '../storage/client.ts';
import type { Auth } from '../storage/jobs.ts';
import { UsageError } from './output.ts';

export interface WorktreeOptions {
  token?: string;
  revision?: string;
  repo?: string;
  path?: string;
}

export const WORKTREE_HELP = `Usage: orch worktree <command> <job-id> [options]

  create <id> [--repo <clone>]        Create (or confirm) the job's isolated worktree and branch
  show <id>                           Inspect: branch, HEAD, dirty files, commits vs base
  adopt <id> --path <dir> [--repo <clone>]
                                      Record an existing worktree of the same repository
  remove <id>                         Remove the worktree directory (refused if dirty; branch kept)
  integrate <id>                      Merge the base branch into the job branch (aborts on conflict)

Mutating commands need --token (or $ORCH_TOKEN); --revision <n> rejects stale state.
Worktrees live under <data>/worktrees/<repo>/<job-id>, never inside a project checkout.
`;

export function runWorktree(
  store: Store,
  args: string[],
  o: WorktreeOptions,
  env = process.env,
): unknown {
  const [cmd, id] = args;
  const auth: Auth = { token: o.token ?? env['ORCH_TOKEN'] };
  if (o.revision !== undefined) {
    const n = Number(o.revision);
    if (!Number.isInteger(n) || n < 0)
      throw new UsageError('--revision must be a non-negative integer');
    auth.expectRevision = n;
  }
  if (cmd === undefined) throw new UsageError(WORKTREE_HELP);
  if (!id) throw new UsageError(`Missing required <job-id>\n\n${WORKTREE_HELP}`);
  switch (cmd) {
    case 'create':
      return createWorktree(store, id, auth, { repo: o.repo });
    case 'show':
      return showWorktree(store, id);
    case 'adopt':
      if (!o.path) throw new UsageError('Missing required --path <dir>');
      return adoptWorktree(store, id, auth, o.path, { repo: o.repo });
    case 'remove':
      return dropWorktree(store, id, auth);
    case 'integrate':
      return integrateBase(store, id, auth);
    default:
      throw new UsageError(`Unknown worktree command: ${cmd}\n\n${WORKTREE_HELP}`);
  }
}
