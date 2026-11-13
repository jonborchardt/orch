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
