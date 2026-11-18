/**
 * Filesystem conventions for the orchestrator.
 *
 * - Install root: where this package lives (read-only; code, skills, agents).
 * - Runtime root: per-user mutable state (config, data, logs, tmp). Never inside the package.
 * - Project root: the Git repository the CLI was invoked from, if any.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'orch';
/** Set this to redirect all runtime state (dev, tests, side-by-side installs). */
export const HOME_ENV = 'ORCH_HOME';

export interface RuntimePaths {
  /** User-editable configuration. */
  config: string;
  /** Shared database, job records, artifacts. */
  data: string;
  logs: string;
  tmp: string;
}

type Env = Record<string, string | undefined>;

/** Resolve mutable runtime directories. Pure: pass env/platform/home for testing. */
export function runtimePaths(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): RuntimePaths {
  const override = env[HOME_ENV];
  if (override) {
    return {
      config: override,
      data: override,
      logs: join(override, 'logs'),
      tmp: join(override, 'tmp'),
    };
  }

  let config: string;
  let data: string;
  if (platform === 'win32') {
    config = join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), APP_NAME);
    data = join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), APP_NAME);
  } else if (platform === 'darwin') {
    config = join(home, 'Library', 'Application Support', APP_NAME);
    data = config;
  } else {
    config = join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), APP_NAME);
    data = join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), APP_NAME);
  }
  return { config, data, logs: join(data, 'logs'), tmp: join(data, 'tmp') };
}

/**
 * Absolute real path, lower-cased on Windows, so two spellings of one location compare equal
 * (`e:\x` versus `E:\x`, a junction versus its target). A path that does not exist is only
 * resolved and normalized.
 */
export function canonicalPath(p: string): string {
  let real = resolve(p);
  try {
    real = realpathSync.native(real);
  } catch {
    /* keep unresolved */
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Root of this package checkout/installation (parent of `src/` or `dist/`). */
export function installRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

export function packageInfo(): { name: string; version: string } {
  const raw = readFileSync(join(installRoot(), 'package.json'), 'utf8');
  return JSON.parse(raw) as { name: string; version: string };
}

/** Top-level directory of the Git repository containing `cwd`, or undefined if none. */
export function findProjectRoot(cwd: string = process.cwd()): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return resolve(out.trim()); // git prints forward slashes even on Windows
  } catch {
    return undefined;
  }
}

/** Shared SQLite database for all repositories. */
export function databasePath(paths: RuntimePaths = runtimePaths()): string {
  return join(paths.data, 'orch.sqlite');
}

/** Lock held by the one `orch verify` running checks for this runtime home. */
export function verifyLockPath(paths: RuntimePaths = runtimePaths()): string {
  return join(paths.data, 'verify.lock');
}

/** Queue entries of `orch verify` runs waiting for the verify lock, one file per waiter. */
export function verifyQueueDir(paths: RuntimePaths = runtimePaths()): string {
  return join(paths.data, 'verify-queue');
}

/** The opt-in recovery worker's PID file, last-pass status, and log (`orch recover`). */
export function recoveryPaths(paths: RuntimePaths = runtimePaths()): {
  pid: string;
  status: string;
  log: string;
} {
  return {
    pid: join(paths.data, 'recovery.pid'),
    status: join(paths.data, 'recovery-status.json'),
    log: join(paths.logs, 'recovery.log'),
  };
}

/** Per-job artifact directory (spec.md, build.md, round-N/...). Distinct from any worktree. */
export function jobArtifactDir(jobId: string, paths: RuntimePaths = runtimePaths()): string {
  return join(paths.data, 'jobs', jobId, 'artifacts');
}

/** Filesystem-safe form of a repository identity, e.g. github.com/o/r -> github.com-o-r. */
export function repoSlug(identity: string): string {
  return identity.replace(/[^a-z0-9._]+/gi, '-').replace(/^-+|-+$/g, '') || 'repo';
}

/** Managed worktree location for a job. Under the data dir, never inside the project. */
export function jobWorktreeDir(
  jobId: string,
  repoIdentity: string,
  paths: RuntimePaths = runtimePaths(),
): string {
  return join(paths.data, 'worktrees', repoSlug(repoIdentity), jobId);
}

/** Built dashboard assets shipped with this installation. */
export function webDistDir(): string {
  return join(installRoot(), 'web', 'dist');
}

/** Directory of Drizzle migrations shipped with this installation. */
export function migrationsDir(): string {
  return join(installRoot(), 'drizzle');
}

/** The user's global Claude Code configuration directory. */
export function claudeHome(env: Env = process.env, home: string = homedir()): string {
  return env['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude');
}
