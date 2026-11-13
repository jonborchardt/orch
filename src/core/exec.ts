/**
 * Safe subprocess helpers. No shell strings are ever built from caller input: tool names are
 * validated against an allowlist pattern, executables are resolved via PATH by this module, and
 * arguments are always passed as arrays.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

const TOOL_NAME = /^[a-z][a-z0-9-]*$/i;
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
  if (r.error) return { status: null, stdout: '', stderr: r.error.message };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export interface CommandOptions {
  cwd: string;
  timeout: number;
  env?: NodeJS.ProcessEnv;
  /** Output cap per stream; the process is killed when exceeded (`error` says so). */
  maxBuffer?: number;
}

/**
 * Run a named tool (resolved on PATH) with an argument array, for verification commands. Unlike
 * `spawnTool`, never throws for a missing tool, and reports timeouts and signals explicitly.
 * Windows `.cmd`/`.bat` shims (npm, npx, pnpm) must go through cmd.exe, which parses text, so
 * their arguments are restricted to plain tokens; anything else is refused as a launch error.
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

/**
 * Run a tool with an argument array and return trimmed stdout, or undefined on any failure.
 * Windows `.cmd`/`.bat` shims (npm-installed CLIs) can only be started by cmd.exe, so those are
 * invoked through `cmd.exe /d /s /c` with the resolved absolute path (quoted) and fixed arguments.
 */
export function runTool(
  name: string,
  args: readonly string[],
  timeout = 10_000,
): string | undefined {
  const exe = whichSync(name);
  if (!exe) return undefined;
  // stdout is captured; stderr is captured too (and discarded) so a chatty tool stays quiet.
  const opts = { encoding: 'utf8' as const, stdio: 'pipe' as const, timeout };
  try {
    const ext = extname(exe).toLowerCase();
    if (WIN && (ext === '.cmd' || ext === '.bat')) {
      if (!isAbsolute(exe) || CMD_META.test(exe) || !args.every((a) => CMD_SAFE_ARG.test(a))) {
        return undefined;
      }
      // /s strips the outer quotes, leaving `"<exe>" <args>`; verbatim stops Node re-quoting.
      const line = `"${exe}" ${args.join(' ')}`;
      const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        ...opts,
        windowsVerbatimArguments: true,
      });
      return r.status === 0 ? r.stdout.trim() : undefined;
    }
    return execFileSync(exe, args, opts).trim();
  } catch {
    return undefined;
  }
}
