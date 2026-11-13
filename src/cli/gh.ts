/** `orch gh ...` handlers: GitHub operations through the gh CLI. */
import { UsageError } from '../core/errors.ts';
import { describeRepo } from '../git/repo.ts';
import { ensureDraftPr, issue, prStatus, pushBranch, resolveRepo } from '../ops/github.ts';
import type { Store } from '../storage/client.ts';
import { authFrom, need } from './args.ts';

export interface GhOptions {
  token?: string;
  revision?: string;
  repo?: string;
  title?: string;
  'body-file'?: string;
}

export const GH_HELP = `Usage: orch gh <command> [options]

  repo [--repo <path>]                GitHub repository for a checkout (identity, default branch)
  issue <ref> [--repo <path>]         Show an issue (#N, N, or URL) of the checkout's repository
  push <job-id>                       Push the job branch to origin (sets upstream; never force)
  pr create <job-id> --body-file <md> [--title <t>]
                                      Create a draft PR, or reuse the existing one (pr stage only)
  pr status <job-id>                  PR state and CI rollup; recorded on the job when --token is given

gh must be installed and authenticated (gh auth login). Nothing here merges, force-pushes, or
marks a PR ready; humans do that.
`;

export function runGh(store: Store, args: string[], o: GhOptions, env = process.env): unknown {
  const [cmd, ...rest] = args;
  const auth = authFrom(o, env);
  switch (cmd) {
    case 'repo': {
      const repo = describeRepo(o.repo ?? process.cwd());
      return resolveRepo({ repo: repo.identity, repoPath: repo.root });
    }
    case 'issue':
      return issue(need(rest[0], '<ref>', GH_HELP), o.repo ?? process.cwd());
    case 'push':
      return pushBranch(store, need(rest[0], '<job-id>', GH_HELP), auth);
    case 'pr': {
      const [sub, id] = rest;
      if (sub === 'create') {
        return ensureDraftPr(store, need(id, '<job-id>', GH_HELP), {
          ...auth,
          title: o.title,
          bodyFile: need(o['body-file'], '--body-file <md>', GH_HELP),
        });
      }
      if (sub === 'status') return prStatus(store, need(id, '<job-id>', GH_HELP), auth);
      throw new UsageError(`Usage: orch gh pr create|status <job-id>\n\n${GH_HELP}`);
    }
    case undefined:
      throw new UsageError(GH_HELP);
    default:
      throw new UsageError(`Unknown gh command: ${cmd}\n\n${GH_HELP}`);
  }
}
