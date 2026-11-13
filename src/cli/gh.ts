/** `orch gh ...` handlers: GitHub operations through the gh CLI. */
import { ensureDraftPr, issue, prStatus, pushBranch, resolveRepo } from '../ops/github.ts';
import type { Store } from '../storage/client.ts';
import { getJob } from '../storage/jobs.ts';
import { describeRepo } from '../git/repo.ts';
import { UsageError } from './output.ts';

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

function revision(o: GhOptions): number | undefined {
  if (o.revision === undefined) return undefined;
  const n = Number(o.revision);
  if (!Number.isInteger(n) || n < 0)
    throw new UsageError('--revision must be a non-negative integer');
  return n;
}

export function runGh(store: Store, args: string[], o: GhOptions, env = process.env): unknown {
  const [cmd, ...rest] = args;
  const token = o.token ?? env['ORCH_TOKEN'];
  const auth = { token, expectRevision: revision(o) };
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new UsageError(`Missing required ${what}\n\n${GH_HELP}`);
    return v;
  };
  switch (cmd) {
    case 'repo': {
      const repo = describeRepo(o.repo ?? process.cwd());
      return resolveRepo({ repo: repo.identity, repoPath: repo.root });
    }
    case 'issue':
      return issue(need(rest[0], '<ref>'), o.repo ?? process.cwd());
    case 'push':
      return pushBranch(store, need(rest[0], '<job-id>'), auth);
    case 'pr': {
      const [sub, id] = rest;
      if (sub === 'create') {
        return ensureDraftPr(store, need(id, '<job-id>'), {
          ...auth,
          title: o.title,
          bodyFile: need(o['body-file'], '--body-file <md>'),
        });
      }
      if (sub === 'status') {
        getJob(store.db, need(id, '<job-id>'));
        return prStatus(store, need(id, '<job-id>'), auth);
      }
      throw new UsageError(`Usage: orch gh pr create|status <job-id>\n\n${GH_HELP}`);
    }
    case undefined:
      throw new UsageError(GH_HELP);
    default:
      throw new UsageError(`Unknown gh command: ${cmd}\n\n${GH_HELP}`);
  }
}
