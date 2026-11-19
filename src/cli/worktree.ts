/** `orch worktree ...` handlers. */
import { UsageError } from '../core/errors.ts';
import { newSessionId } from '../core/ownership.ts';
import { TERMINAL_STATUSES } from '../core/workflow.ts';
import { removeMergedWorktree } from '../ops/actions.ts';
import { getJob } from '../storage/jobs.ts';
import {
  adoptWorktree,
  createWorktree,
  dropWorktree,
  integrateBase,
  showWorktree,
} from '../ops/worktree.ts';
import type { Store } from '../storage/client.ts';
import { authFrom, need } from './args.ts';

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
  remove <id> [--repo <clone>]        Remove the worktree directory (refused if dirty; branch kept)
  integrate <id>                      Merge the base branch into the job branch (aborts on conflict)

Mutating commands need --token (or $ORCH_TOKEN); --revision <n> rejects stale state.
remove without a token works on a finished job whose PR is merged, in a short episode of its own
(exit 4 while another session holds a live lease).
Worktrees live under <data>/worktrees/<repo>/<job-id>, never inside a project checkout.
`;

export function runWorktree(
  store: Store,
  args: string[],
  o: WorktreeOptions,
  env = process.env,
): unknown {
  const [cmd, id] = args;
  const auth = authFrom(o, env);
  if (cmd === undefined) throw new UsageError(WORKTREE_HELP);
  if (!id) throw new UsageError(`Missing required <job-id>\n\n${WORKTREE_HELP}`);
  switch (cmd) {
    case 'create':
      return createWorktree(store, id, auth, { repo: o.repo });
    case 'show':
      return showWorktree(store, id);
    case 'adopt':
      return adoptWorktree(store, id, auth, need(o.path, '--path <dir>'), { repo: o.repo });
    case 'remove':
      // Without a token, a finished job whose PR merged is cleaned up in a short episode of its own.
      if (!auth.token && TERMINAL_STATUSES.includes(getJob(store.db, id).status)) {
        return removeMergedWorktree(store, id, { session: newSessionId(), repo: o.repo });
      }
      return dropWorktree(store, id, auth, { repo: o.repo });
    case 'integrate':
      return integrateBase(store, id, auth);
    default:
      throw new UsageError(`Unknown worktree command: ${cmd}\n\n${WORKTREE_HELP}`);
  }
}
