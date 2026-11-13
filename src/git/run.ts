/** Git invocation with argument arrays. `git` throws ToolError with stderr; `tryGit` returns undefined. */
import { ToolError } from '../core/errors.ts';
import { spawnTool } from '../core/exec.ts';

export function git(cwd: string, ...args: string[]): string {
  const r = spawnTool('git', args, { cwd });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout).trim();
    throw new ToolError(`git ${args[0] ?? ''} failed in ${cwd}: ${detail}`);
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
