/**
 * Safe subprocess helpers. No shell strings are ever built from caller input: tool names are
 * validated against an allowlist pattern, executables are resolved via PATH by this module, and
 * arguments are always passed as arrays.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/** A plain executable name: no paths, no shell syntax. */
export const TOOL_NAME = /^[a-z][a-z0-9-]*$/i;
/** cmd.exe parses its command line as text; only plain fixed arguments are allowed through it. */
const CMD_SAFE_ARG = /^[\w.=:/-]+$/;
const CMD_META = /["&|<>^%!\r\n]/;
const WIN = process.platform === 'win32';

/** An env value by name; case-insensitive on Windows, where a copied env may spell it `Path`. */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (!WIN) return env[key];
  const found = Object.keys(env).find((k) => k.toUpperCase() === key);
  return found === undefined ? undefined : env[found];
}

/**
 * Locate an executable on PATH (honouring PATHEXT on Windows). Only absolute PATH entries are
 * searched: a relative entry (`.`, `bin`) would resolve against the working directory, which may
 * be a repository that planted the executable.
 */
export function whichSync(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!TOOL_NAME.test(name)) throw new Error(`Invalid tool name: ${name}`);
  const exts = WIN ? (envValue(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (envValue(env, 'PATH') ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
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
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ' +
  'ForEach-Object { if ($_.CreationDate) { ' +
  "'{0},{1},{2}' -f $_.ProcessId, $_.ParentProcessId, " +
  '([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }';

/**
 * A cold powershell.exe plus the WMI query takes about 1.5 s idle, but 13-59 s measured with 24
 * busy processes on 12 cores (a full parallel test run, or a verification run beside one): the
 * old 20 s limit timed out there. With one retry (`sweepDescendants`) a pass waits at most 2 min.
 */
const TABLE_TIMEOUT_MS = 60_000;

/** The live process table (pid, parent pid, creation time) through PowerShell. */
function processTable(): ProcRow[] {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_TABLE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TABLE_TIMEOUT_MS,
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
 * When the live process at `pid` started (Unix ms), read-only; null when the platform or the
 * lookup cannot say (no such process, unsupported, error, timeout, unparseable output).
 * Windows: the creation time from `processTable()`. POSIX: `ps -o lstart=`, whole seconds,
 * with `LC_ALL=C` so the date parses.
 */
export function processStartMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (WIN) {
    try {
      return processTable().find((row) => row.pid === pid)?.created ?? null;
    } catch {
      return null;
    }
  }
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TABLE_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (r.error || r.status !== 0) return null;
  const ms = Date.parse(r.stdout.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Terminate what a killed command left running. `spawnSync` kills only the direct child; on
 * Windows a shell between us and the real work (the npm shim is `cmd.exe`) dies alone and the
 * tree under it survives, still holding files and CPU. Each pass reads the table and kills every
 * descendant created since `since`; it stops when a pass finds nothing or after three passes.
 * A read that fails is tried once more before the sweep gives up and reports `error`, so the
 * cleanup is bounded by six reads (a few seconds normally, see TABLE_TIMEOUT_MS for the worst
 * case). Safe to call for a root that already exited.
 */
export function sweepDescendants(
  root: number,
  since: number,
  table: () => ProcRow[] = processTable,
): Cleanup {
  const out: Cleanup = { killed: [], failed: [] };
  const read = () => {
    try {
      return table();
    } catch {
      return table(); // a cold PowerShell under load can miss its limit once; its error stands
    }
  };
  // ponytail: three passes catch processes spawned during a pass; a Job Object would need native code.
  for (let pass = 0; pass < 3; pass++) {
    let pids: number[];
    try {
      pids = descendantsOf(read(), root, since).filter(
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
 * A bare name is resolved with `whichSync` and spawned by absolute path, so the OS never searches
 * `cwd` (Windows does, before PATH): an executable planted in a repository never runs.
 */
export function spawnTool(
  exe: string,
  args: readonly string[],
  opts: { cwd?: string | undefined; timeout?: number | undefined; env?: NodeJS.ProcessEnv } = {},
): ToolResult {
  const env = opts.env ?? process.env;
  let path = exe;
  if (!isAbsolute(exe)) {
    if (!TOOL_NAME.test(exe)) return spawnFailure(`Invalid tool name: ${exe}`);
    const found = whichSync(exe, env);
    if (!found) return spawnFailure(`${exe} not found on PATH`);
    const ext = extname(found).toLowerCase();
    if (WIN && ext !== '.exe' && ext !== '.com') {
      return spawnFailure(`${exe} resolves to ${found}, which cannot be started without a shell`);
    }
    path = found;
  }
  const r = spawnSync(path, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 120_000,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    const timedOut = (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return { status: null, stdout: '', stderr: r.error.message, timedOut };
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A `spawnTool` launch failure: the message is in `stderr`, where `git()` reads it. */
function spawnFailure(message: string): ToolResult {
  return { status: null, stdout: '', stderr: message };
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

/**
 * Run an absolute executable in the foreground of this terminal (inherited stdio, never detached,
 * no shell) and wait for it: resolves with its exit code, null when a signal ended it or it could
 * not start. A SIGINT this process receives meanwhile keeps it alive until the child exits and,
 * on POSIX, is forwarded to the child. On Windows the console already delivers Ctrl-C to the
 * child, and `kill('SIGINT')` there would terminate it without its own cleanup, so nothing is sent.
 */
export function runForeground(exe: string, args: readonly string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: 'inherit' });
    const forward = () => {
      if (!WIN) child.kill('SIGINT');
    };
    process.on('SIGINT', forward);
    let settled = false;
    const end = (code: number | null) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', forward);
      resolve(code);
    };
    child.on('error', () => {
      end(null);
    });
    child.on('exit', (code) => {
      end(code);
    });
  });
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
