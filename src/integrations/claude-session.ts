/**
 * The one place `orch` starts a Claude Code process: the headless `claude -p` child of the
 * foreground factory controller (decision 2026-11-21-foreground-factory-runner). Asynchronous,
 * no timeout: a session runs for as long as its job needs, and only its exit says it ended.
 * Its stdout is Claude Code's `stream-json`, turned into one short line per step for the caller;
 * its stderr is shown as it comes and its tail kept (decision 2026-11-23-live-claude-output).
 * Nothing here knows about jobs; the caller reads the job row afterwards.
 */
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';

import { ToolError } from '../core/errors.ts';
import { sweepDescendants, whichSync } from '../core/exec.ts';

/** Tests point this at a Node script that stands in for `claude` (run as `node <script> <args>`). */
export const CLAUDE_SHIM_ENV = 'ORCH_CLAUDE_SHIM';
/** How much of the child's stderr is kept for the record: its last characters. */
export const STDERR_TAIL_CHARS = 4000;
const LINE_CHARS = 160;
const RESULT_CHARS = 1000;
/** How long to wait, after the process exited, for its last output to be read. */
const DRAIN_MS = 2000;

export interface LaunchInput {
  /** Working directory: the job's worktree. */
  cwd: string;
  prompt: string;
  /** Permission arguments (`runnerArgsFor`: `runnerClaudeArgs` plus the allowed-tool additions). */
  args: readonly string[];
  /** Display name of the session. */
  name: string;
  /** The conversation's id (`--session-id`): its transcript is `<uuid>.jsonl`. */
  sessionId: string;
  env: NodeJS.ProcessEnv;
  /** Receives one short display line per step the child reports. */
  onLine?: ((line: string) => void) | undefined;
}

/** The child's final `result` line, clipped. */
export interface ClaudeResult {
  subtype: string | null;
  isError: boolean | null;
  result: string | null;
  numTurns: number | null;
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
  /** Why the process could not be started, else null. */
  error: string | null;
  /** The last `STDERR_TAIL_CHARS` the child wrote to stderr. */
  stderrTail?: string | undefined;
  result?: ClaudeResult | null | undefined;
}

export interface ClaudeChild {
  pid: number;
  startedAt: string;
  /** Resolves when the process has exited; never rejects. */
  done: Promise<ChildExit>;
  /** End the process and what it started. Safe to call after it exited. */
  kill(): void;
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** One stdout line as a JSON object, or null when it is not one. */
function parseLine(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** What a tool call is about, in a few words: its command, file, pattern, or description. */
function toolSubject(input: unknown): string {
  const i = rec(input);
  for (const k of ['description', 'command', 'file_path', 'pattern', 'url', 'skill', 'prompt']) {
    const v = str(i[k]);
    if (v !== null) return v;
  }
  return '';
}

/**
 * Display lines for one stdout line of `stream-json`: text and tool calls of assistant turns
 * (`agent` marks a subagent's), the session start, and the result. A line that is not JSON is
 * returned as it is; an unknown type gives nothing.
 */
function displayLines(raw: string, m: Record<string, unknown> | null): string[] {
  if (m === null) return raw.trim() === '' ? [] : [raw];
  if (m['type'] === 'system' && m['subtype'] === 'init') {
    return [`session ${str(m['session_id']) ?? '?'} (${str(m['model']) ?? 'model ?'})`];
  }
  if (m['type'] === 'assistant') {
    const who = m['parent_tool_use_id'] ? 'agent ' : '';
    const content = rec(m['message'])['content'];
    const out: string[] = [];
    for (const b of Array.isArray(content) ? content : []) {
      const block = rec(b);
      const text = str(block['text']);
      if (block['type'] === 'text' && text !== null && text.trim() !== '') {
        out.push(clip(`${who}${text}`, LINE_CHARS));
      }
      if (block['type'] === 'tool_use') {
        const name = str(block['name']) ?? '?';
        out.push(clip(`${who}${name}: ${toolSubject(block['input'])}`, LINE_CHARS));
      }
    }
    return out;
  }
  if (m['type'] === 'result') {
    const r = resultOf(m);
    return [
      clip(
        `result ${r.subtype ?? '?'}${r.isError ? ' (error)' : ''}, ` +
          `${String(r.numTurns ?? '?')} turns: ${r.result ?? ''}`,
        LINE_CHARS,
      ),
    ];
  }
  return [];
}

function resultOf(m: Record<string, unknown>): ClaudeResult {
  const result = str(m['result']);
  return {
    subtype: str(m['subtype']),
    isError: typeof m['is_error'] === 'boolean' ? m['is_error'] : null,
    result: result === null ? null : result.slice(0, RESULT_CHARS),
    numTurns: typeof m['num_turns'] === 'number' ? m['num_turns'] : null,
  };
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
  // --name ends the variadic --allowedTools list, so orch's own flags and the prompt follow it.
  // stream-json in print mode needs --verbose.
  const args = [
    ...(shim ? [shim] : []),
    '-p',
    ...input.args,
    '--name',
    input.name,
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    input.sessionId,
    input.prompt,
  ];
  const startedMs = Date.now();
  const posix = process.platform !== 'win32';
  const child = spawn(exe, args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Its own process group on POSIX, so the whole tree can be signalled at once.
    detached: posix,
  });
  const pid = child.pid ?? 0;
  let stderrTail = '';
  let result: ClaudeResult | null = null;
  // Both pipes are read for the child's whole life, so it never stalls on a full one.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (raw) => {
    const m = parseLine(raw);
    if (m?.['type'] === 'result') result = resultOf(m);
    for (const line of displayLines(raw, m)) input.onLine?.(line);
  });
  const done = new Promise<ChildExit>((resolve) => {
    const finish = (code: number | null, signal: string | null, error: string | null) => {
      resolve({ code, signal, error, stderrTail, result });
    };
    child.once('error', (err) => {
      finish(null, null, err.message);
    });
    child.once('exit', (code, signal) => {
      // Its last output may still be in the pipes; a grandchild holding them open must not
      // keep the wait going, so 'close' is waited for only briefly.
      const late = setTimeout(() => {
        finish(code, signal, null);
      }, DRAIN_MS);
      child.once('close', () => {
        clearTimeout(late);
        finish(code, signal, null);
      });
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
