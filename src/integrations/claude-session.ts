/**
 * The one place `orch` starts a Claude Code process: the headless `claude -p` child of the
 * foreground factory controller (decision 2026-11-21-foreground-factory-runner). Asynchronous,
 * output inherited, no timeout: a session runs for as long as its job needs, and only its exit
 * says it ended. Nothing here knows about jobs; the caller reads the job row afterwards.
 */
import { spawn } from 'node:child_process';
import { extname } from 'node:path';

import { ToolError } from '../core/errors.ts';
import { sweepDescendants, whichSync } from '../core/exec.ts';

/** Tests point this at a Node script that stands in for `claude` (run as `node <script> <args>`). */
export const CLAUDE_SHIM_ENV = 'ORCH_CLAUDE_SHIM';

export interface LaunchInput {
  /** Working directory: the job's worktree. */
  cwd: string;
  prompt: string;
  /** Permission arguments (`runnerClaudeArgs`). */
  args: readonly string[];
  /** Display name of the session. */
  name: string;
  env: NodeJS.ProcessEnv;
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
  /** Why the process could not be started, else null. */
  error: string | null;
}

export interface ClaudeChild {
  pid: number;
  startedAt: string;
  /** Resolves when the process has exited; never rejects. */
  done: Promise<ChildExit>;
  /** End the process and what it started. Safe to call after it exited. */
  kill(): void;
}

export function launchClaude(input: LaunchInput): ClaudeChild {
  const shim = input.env[CLAUDE_SHIM_ENV];
  const exe = shim ? process.execPath : whichSync('claude', input.env);
  if (!exe) {
    throw new ToolError(
      'claude was not found on PATH. Install Claude Code and sign in (run claude once), then retry.',
    );
  }
  if (['.cmd', '.bat'].includes(extname(exe).toLowerCase())) {
    // A shim is started by cmd.exe, which parses text: the prompt and the permission rules
    // cannot be passed through it safely.
    throw new ToolError(
      `claude resolves to the shim ${exe}, which cannot take the factory prompt safely. ` +
        'Install the native Claude Code build (claude.exe) and put it first on PATH.',
    );
  }
  // --name ends the variadic --allowedTools list, so the prompt stays the positional argument.
  const args = [...(shim ? [shim] : []), '-p', ...input.args, '--name', input.name, input.prompt];
  const startedMs = Date.now();
  const posix = process.platform !== 'win32';
  const child = spawn(exe, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    // Its own process group on POSIX, so the whole tree can be signalled at once.
    detached: posix,
  });
  const pid = child.pid ?? 0;
  const done = new Promise<ChildExit>((resolve) => {
    child.once('error', (err) => {
      resolve({ code: null, signal: null, error: err.message });
    });
    child.once('exit', (code, signal) => {
      resolve({ code, signal, error: null });
    });
  });
  return {
    pid,
    startedAt: new Date(startedMs).toISOString(),
    done,
    kill: () => {
      if (pid === 0) return;
      try {
        if (posix) process.kill(-pid, 'SIGTERM');
        else child.kill();
      } catch {
        /* already gone */
      }
      // Windows ends only the process itself; its subagents and tools are swept by parent id.
      if (!posix) sweepDescendants(pid, startedMs);
    },
  };
}
