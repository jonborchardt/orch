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
  /** Descendant processes dealt with after a kill (Windows only; see `sweepDescendants`). */
  cleanup?: Cleanup;
}

/** Outcome of terminating what a killed command left behind. */
export interface Cleanup {
  killed: number[];
  /** Still alive after a termination attempt (permission denied). */
  failed: number[];
  /** The process table could not be read; nothing beyond the direct child was terminated. */
  error?: string;
}

export interface ProcRow {
  pid: number;
  ppid: number;
  /** Creation time, Unix milliseconds. */
  created: number;
}

/**
 * Every process under `root` in the table (children, grandchildren, ...), restricted to those
 * created at or after `since`. Windows keeps an orphan's parent id pointing at its dead parent, so
 * the tree can still be walked from a pid that no longer exists; the time bound keeps a reused
 * pid from pulling in an unrelated process that merely shares the number.
 */
export function descendantsOf(rows: readonly ProcRow[], root: number, since: number): number[] {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    for (const c of children.get(p) ?? []) {
      if (c.created < since || seen.has(c.pid)) continue;
      seen.add(c.pid);
      found.push(c.pid);
      queue.push(c.pid);
    }
  }
  return found;
}

const PS_TABLE =
  'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { ' +
  "'{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, " +
  '([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }';

/** The live process table (pid, parent pid, creation time) through PowerShell. */
function processTable(): ProcRow[] {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_TABLE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    throw new Error(
      r.error?.message ?? `powershell exited ${String(r.status)}: ${r.stderr.trim()}`,
    );
  }
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.split(',').map(Number))
    .filter((f) => f.length === 3 && f.every((n) => Number.isFinite(n)))
    .map(([pid, ppid, created]) => ({ pid: pid ?? 0, ppid: ppid ?? 0, created: created ?? 0 }));
}

/**
 * Terminate what a killed command left running. `spawnSync` kills only the direct child; on
 * Windows a shell between us and the real work (the npm shim is `cmd.exe`) dies alone and the
 * tree under it survives, still holding files and CPU. Each pass reads the table and kills every
 * descendant created since `since`; it stops when a pass finds nothing or after three passes,
 * which bounds the cleanup to a few seconds. Safe to call for a root that already exited.
 */
export function sweepDescendants(
  root: number,
  since: number,
  table: () => ProcRow[] = processTable,
): Cleanup {
  const out: Cleanup = { killed: [], failed: [] };
  // ponytail: three passes catch processes spawned during a pass; a Job Object would need native code.
  for (let pass = 0; pass < 3; pass++) {
    let pids: number[];
    try {
      pids = descendantsOf(table(), root, since).filter(
        (p) => !out.killed.includes(p) && !out.failed.includes(p),
      );
    } catch (err) {
      out.error = (err as Error).message;
      return out;
    }
    if (pids.length === 0) return out;
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
        out.killed.push(pid);
      } catch (err) {
        // ESRCH: gone on its own; anything else (EPERM) is a process we could not stop.
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') out.failed.push(pid);
      }
    }
  }
  return out;
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
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { status: null, stdout: '', stderr: r.error.message, timedOut };
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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
  const startedAt = Date.now();
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
  // spawnSync killed the child (timeout or output cap); take its descendants with it.
  if (WIN && r.pid && (code === 'ETIMEDOUT' || code === 'ENOBUFS')) {
    out.cleanup = sweepDescendants(r.pid, startedAt);
  }
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
