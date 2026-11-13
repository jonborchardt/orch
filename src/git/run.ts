/** Git invocation with argument arrays. `git` throws ToolError (exit status, signal, stderr); `tryGit` returns undefined. */
import { ToolError } from '../core/errors.ts';
import { failureDetail, spawnTool } from '../core/exec.ts';

export function git(cwd: string, ...args: string[]): string {
  const r = spawnTool('git', args, { cwd });
  if (r.status !== 0) {
    throw new ToolError(`git ${args[0] ?? ''} failed in ${cwd} ${failureDetail(r)}`);
  }
  return r.stdout.trim();
}

export function tryGit(cwd: string, ...args: string[]): string | undefined {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
}
