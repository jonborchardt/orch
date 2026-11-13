/**
 * Safe subprocess helpers. No shell strings are ever built from caller input: tool names are
 * validated against an allowlist pattern, executables are resolved via PATH by this module, and
 * arguments are always passed as arrays.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/** A plain executable name: no paths, no shell syntax. */
export const TOOL_NAME = /^[a-z][a-z0-9-]*$/i;
/** cmd.exe parses its command line as text; only plain fixed arguments are allowed through it. */
const CMD_SAFE_ARG = /^[\w.=:/-]+$/;
const CMD_META = /["&|<>^%!\r\n]/;
const WIN = process.platform === 'win32';

/** Locate an executable on PATH (honouring PATHEXT on Windows). */
export function whichSync(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!TOOL_NAME.test(name)) throw new Error(`Invalid tool name: ${name}`);
  const exts = WIN ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface ToolResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Terminating signal, when the process did not exit on its own. */
  signal?: string | null;
  /** True when `timeout` elapsed and the process was killed. */
  timedOut?: boolean;
  /** Set when the process could not be started (missing executable, EACCES, ...). */
  error?: string;
}

/**
 * Run a native executable with an argument array and return its exit status and output.
 * Unlike `runTool` this never goes through cmd.exe, so arbitrary arguments (titles, bodies,
 * paths with spaces) are safe. Returns status null with the error text when it cannot start.
 */
export function spawnTool(
  exe: string,
  args: readonly string[],
  opts: { cwd?: string | undefined; timeout?: number | undefined; env?: NodeJS.ProcessEnv } = {},
): ToolResult {
  const r = spawnSync(exe, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 120_000,
    env: opts.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const signal = r.signal ?? null;
  if (r.error) {
    // stderr keeps the error text for callers that only print stderr.
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const out: ToolResult = { status: null, stdout: '', stderr: r.error.message, signal };
    if (timedOut) out.timedOut = true;
    else out.error = r.error.message;
    return out;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, signal };
}

/**
 * How a tool run failed, for error messages: exit status (with the NTSTATUS in hex on Windows,
 * e.g. 0xC0000142 when a process cannot initialise), signal, timeout, launch error, then the
 * tool's own stderr (or stdout). Never only stderr, which is empty for a killed process.
 */
export function failureDetail(r: ToolResult): string {
  const hex =
    r.status !== null && r.status > 0xffff ? ` (0x${r.status.toString(16).toUpperCase()})` : '';
  const parts = [`exit status ${r.status === null ? 'none' : String(r.status)}${hex}`];
  if (r.signal) parts.push(`signal ${r.signal}`);
  if (r.timedOut) parts.push('timed out');
  if (r.error) parts.push('could not start');
  const text = (r.stderr || r.stdout).trim();
  return `(${parts.join(', ')})${text ? `: ${text}` : ''}`;
}

export interface CommandOptions {
  cwd?: string | undefined;
  timeout: number;
  env?: NodeJS.ProcessEnv;
  /** Output cap per stream; the process is killed when exceeded (`error` says so). */
  maxBuffer?: number;
}

/**
 * Run a named tool (resolved on PATH) with an argument array. Never throws for a missing tool,
 * and reports timeouts and signals explicitly. Windows `.cmd`/`.bat` shims (npm, npx, pnpm) can
 * only be started by cmd.exe, which parses text, so they are invoked through `cmd.exe /d /s /c`
 * with the resolved absolute path (quoted) and arguments restricted to plain tokens; anything
 * else is refused as a launch error.
 */
export function spawnCommand(
  name: string,
  args: readonly string[],
  opts: CommandOptions,
): ToolResult {
  if (!TOOL_NAME.test(name)) return launchError(`Invalid tool name: ${name}`);
  const exe = whichSync(name, opts.env ?? process.env);
  if (!exe) return launchError(`${name} not found on PATH`);
  const base = {
    cwd: opts.cwd,
    encoding: 'utf8' as const,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout,
    killSignal: 'SIGKILL' as const,
    env: opts.env ?? process.env,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    windowsHide: true,
  };
  const ext = extname(exe).toLowerCase();
  let r;
  if (WIN && (ext === '.cmd' || ext === '.bat')) {
    if (!isAbsolute(exe) || CMD_META.test(exe)) return launchError(`Unsafe shim path: ${exe}`);
    const bad = args.find((a) => !CMD_SAFE_ARG.test(a));
    if (bad !== undefined) {
      return launchError(
        `Argument ${JSON.stringify(bad)} cannot be passed through the ${name} shim`,
      );
    }
    const line = `"${exe}" ${args.join(' ')}`;
    r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...base,
      windowsVerbatimArguments: true,
    });
  } else {
    r = spawnSync(exe, args, base);
  }
  const out: ToolResult = {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    signal: r.signal ?? null,
  };
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') out.timedOut = true;
  else if (r.error) out.error = r.error.message;
  return out;
}

function launchError(message: string): ToolResult {
  return { status: null, stdout: '', stderr: '', signal: null, error: message };
}

/** Run a tool with an argument array and return trimmed stdout, or undefined on any failure. */
export function runTool(
  name: string,
  args: readonly string[],
  timeout = 10_000,
): string | undefined {
  const r = spawnCommand(name, args, { timeout });
  return r.status === 0 ? r.stdout.trim() : undefined;
}
