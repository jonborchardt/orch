/**
 * Is the installed build older than its checkout? `npm run build` stamps `dist/build-info.json`
 * with the commit it built; this compares it with the install root's `HEAD` and upstream using
 * local refs only. Read-only: it never fetches, pulls, or rebuilds, so the upstream is only as
 * fresh as the last fetch.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { installRoot } from '../core/paths.ts';
import { tryGit } from '../git/run.ts';

export interface InstallBuild {
  builtFrom: string;
  head: string;
  upstream: string | null;
  stale: boolean;
  message: string;
}

export const BUILD_INFO = join('dist', 'build-info.json');

/** The advice that ends a stale build's message. */
export const REBUILD_STEPS = 'pull, `npm run build`, `orch install`';

/**
 * The installed build's identity: the stamp's commit and the file's modification time, so a
 * rebuild from the same commit differs too. Null when there is no stamp; never throws, runs no Git.
 */
export function buildStamp(root: string = installRoot()): string | null {
  const stamp = readStamp(root);
  return stamp === null ? null : `${String(stamp.commit)}@${String(stamp.mtimeMs)}`;
}

/** The stamp's commit and modification time; null when it cannot be read. */
function readStamp(root: string): { commit: unknown; mtimeMs: number } | null {
  const file = join(root, BUILD_INFO);
  try {
    const { commit } = JSON.parse(readFileSync(file, 'utf8')) as { commit?: unknown };
    return { commit, mtimeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** Null when there is no stamp or `root` is not a Git checkout; never throws. */
export function installBuild(root: string = installRoot()): InstallBuild | null {
  const builtFrom = readStamp(root)?.commit;
  // A full object name only, so the stamp can never be read as a Git option.
  if (typeof builtFrom !== 'string' || !/^[0-9a-f]{40,64}$/.test(builtFrom)) return null;
  const [head, branch] =
    tryGit(root, 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD')?.split('\n') ?? [];
  if (!head || !branch) return null;
  const [upstream, upName] =
    tryGit(root, 'rev-parse', '@{u}', '--abbrev-ref', '@{u}')?.split('\n') ?? [];
  // Behind `ref`, or a commit this checkout does not know (rev-list fails).
  const behind = (ref: string) =>
    ref !== builtFrom &&
    Number(tryGit(root, 'rev-list', '--count', `${builtFrom}..${ref}`) ?? 1) > 0;
  const ahead =
    upstream && upName && behind(upstream)
      ? { name: upName, sha: upstream }
      : behind(head)
        ? { name: branch, sha: head }
        : null;
  const short = (sha: string) => sha.slice(0, 7);
  return {
    builtFrom,
    head,
    upstream: upstream ?? null,
    stale: ahead !== null,
    message:
      ahead === null
        ? `built from ${short(builtFrom)}, current with ${branch}`
        : `built from ${short(builtFrom)}, ${ahead.name} is at ${short(ahead.sha)}: ${REBUILD_STEPS}`,
  };
}
