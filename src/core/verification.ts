/**
 * Verification policy and evidence rules. Pure: parses a repository's `factory.json`
 * `verification` section, fingerprints it, compares two policies, and decides whether a recorded
 * run is still valid evidence for a commit. Running commands is `src/ops/verify.ts`.
 */
import { createHash } from 'node:crypto';

import { ValidationError } from './errors.ts';
import { TOOL_NAME } from './exec.ts';
import { type ChangeStatus, classifyChanges } from './sensitive.ts';

/** Name of the repository-level policy file (at the worktree root). */
export const POLICY_FILE = 'factory.json';
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MAX_TIMEOUT_MS = 60 * 60_000;
/** Output kept per check (head + tail); the rest is dropped and the log marked truncated. */
export const OUTPUT_CAP = 256 * 1024;

const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface VerificationCheckSpec {
  id: string;
  /** Executable name resolved on PATH; never a shell string. */
  command: string;
  args: string[];
  /** Working directory relative to the worktree root. */
  cwd: string;
  required: boolean;
  timeoutMs: number;
}

/**
 * Which run is the authoritative test gate: `local` (the default) runs the full policy locally
 * and CI once more at the end; `ci` runs only the policy's fast checks locally and needs GitHub CI
 * to pass on the exact commit before review (decision 2026-11-22-ci-authoritative-verification).
 */
export const AUTHORITIES = ['local', 'ci'] as const;
export type Authority = (typeof AUTHORITIES)[number];

/**
 * The opt-in bug-fix regression command: run with the job's changed test files appended, once
 * with the non-test changes reverted to the merge base (must fail) and once at HEAD (must pass).
 */
export type RegressionSpec = Omit<VerificationCheckSpec, 'id' | 'required'>;

export interface VerificationPolicy {
  commands: VerificationCheckSpec[];
  /** Absent means `local`. */
  authority?: Authority | undefined;
  /** Absent means no regression evidence is recorded. */
  regression?: RegressionSpec | undefined;
}

/** The policy's authority, `local` when it names none. */
export function authorityOf(policy: VerificationPolicy): Authority {
  return policy.authority ?? 'local';
}

export type PolicySource = 'baseline' | 'authorized';
export type RunStatus = 'running' | 'passed' | 'failed' | 'interrupted';
export type CheckStatus = 'pending' | 'passed' | 'failed' | 'timed-out' | 'error';
export type IntegrationStatus = 'started' | 'up-to-date' | 'merged' | 'conflict' | 'interrupted';

function fail(msg: string): never {
  throw new ValidationError(`${POLICY_FILE}: ${msg}`);
}

/** Parse the `verification` section of a repository factory.json. Strict: unknown keys fail. */
export function parsePolicy(raw: unknown): VerificationPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('must be a JSON object');
  const top = raw as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== 'verification') fail(`unknown key "${key}" (only "verification" is allowed)`);
  }
  const v = top['verification'];
  if (v === undefined) return { commands: [] };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail('"verification" must be an object');
  }
  const section = v as Record<string, unknown>;
  for (const key of Object.keys(section)) {
    if (key !== 'commands' && key !== 'authority' && key !== 'regression') {
      fail(`verification: unknown key "${key}"`);
    }
  }
  const list = section['commands'];
  if (!Array.isArray(list)) fail('verification.commands must be an array');
  const commands = list.map((item, i) => parseCheck(item, `verification.commands[${String(i)}]`));
  const ids = new Set<string>();
  for (const c of commands) {
    if (ids.has(c.id)) fail(`duplicate check id "${c.id}"`);
    ids.add(c.id);
  }
  const authority = section['authority'] === undefined ? 'local' : section['authority'];
  if (!AUTHORITIES.includes(authority as Authority)) {
    fail(`verification.authority must be one of ${AUTHORITIES.map((a) => `"${a}"`).join(', ')}`);
  }
  // `local` is the default, so it is not stored: every existing policy keeps its exact shape.
  const out: VerificationPolicy = { commands };
  if (authority === 'ci') out.authority = 'ci';
  if (section['regression'] !== undefined) out.regression = parseRegression(section['regression']);
  return out;
}

function parseRegression(item: unknown): RegressionSpec {
  const where = 'verification.regression';
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    fail(`${where} must be an object`);
  }
  for (const key of Object.keys(item)) {
    if (!['command', 'args', 'cwd', 'timeoutMs'].includes(key)) {
      fail(`${where}: unknown key "${key}"`);
    }
  }
  const { command, args, cwd, timeoutMs } = parseCheck({ ...item, id: 'regression' }, where);
  return { command, args, cwd, timeoutMs };
}

/** Parse the text of a factory.json (`where` names the source in the error, e.g. a commit). */
export function parsePolicyText(text: string, where = POLICY_FILE): VerificationPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`${where} is not JSON: ${(err as Error).message}`);
  }
  return parsePolicy(raw);
}

/** The text `orch init` writes: pretty-printed, keys in a fixed order, defaults omitted. */
export function formatPolicy(policy: VerificationPolicy): string {
  const commands = policy.commands.map((c) => ({
    id: c.id,
    command: c.command,
    args: c.args,
    ...(c.cwd === '.' ? {} : { cwd: c.cwd }),
    ...(c.required ? {} : { required: false }),
    ...(c.timeoutMs === DEFAULT_TIMEOUT_MS ? {} : { timeoutMs: c.timeoutMs }),
  }));
  const ci = authorityOf(policy) === 'ci' ? { authority: 'ci' } : {};
  return JSON.stringify({ verification: { ...ci, commands } }, null, 2) + '\n';
}

function parseCheck(item: unknown, where: string): VerificationCheckSpec {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    fail(`${where} must be an object`);
  }
  const o = item as Record<string, unknown>;
  const allowed = new Set(['id', 'command', 'args', 'cwd', 'required', 'timeoutMs']);
  for (const key of Object.keys(o)) if (!allowed.has(key)) fail(`${where}: unknown key "${key}"`);
  const id = o['id'];
  if (typeof id !== 'string' || !CHECK_ID.test(id)) {
    fail(`${where}.id must match ${CHECK_ID.source}`);
  }
  const command = o['command'];
  if (typeof command !== 'string' || !TOOL_NAME.test(command)) {
    fail(`${where}.command must be a plain executable name (no paths, no shell)`);
  }
  const args = o['args'] ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !/[\r\n\0]/.test(a))) {
    fail(`${where}.args must be an array of single-line strings`);
  }
  const cwd = o['cwd'] ?? '.';
  if (typeof cwd !== 'string' || cwd === '' || /^[/\\]|^[a-zA-Z]:|\0/.test(cwd)) {
    fail(`${where}.cwd must be a relative path`);
  }
  if (cwd.split(/[/\\]/).includes('..')) fail(`${where}.cwd must not contain ".."`);
  const required = o['required'] ?? true;
  if (typeof required !== 'boolean') fail(`${where}.required must be a boolean`);
  const timeoutMs = o['timeoutMs'] ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    fail(`${where}.timeoutMs must be an integer between 1000 and ${String(MAX_TIMEOUT_MS)}`);
  }
  return {
    id,
    command,
    args: args as string[],
    cwd:
      cwd
        .split('\\')
        .join('/')
        .replace(/^\.\/+/, '') || '.',
    required,
    timeoutMs,
  };
}

/**
 * Canonical form: the parsed checks in order with sorted keys, so formatting changes do not count.
 * The authority joins only when it is `ci`, and the regression command only when set, so every
 * policy without them keeps its fingerprint.
 */
export function canonicalPolicy(policy: VerificationPolicy): string {
  const checks = policy.commands.map((c) => ({
    args: c.args,
    command: c.command,
    cwd: c.cwd,
    id: c.id,
    required: c.required,
    timeoutMs: c.timeoutMs,
  }));
  const ci = authorityOf(policy) === 'ci';
  const r = policy.regression;
  if (!ci && !r) return JSON.stringify(checks);
  return JSON.stringify({
    ...(ci ? { authority: 'ci' } : {}),
    commands: checks,
    ...(r ? { regression: canonicalRegression(r) } : {}),
  });
}

function canonicalRegression(r: RegressionSpec | undefined): RegressionSpec | undefined {
  return r && { args: r.args, command: r.command, cwd: r.cwd, timeoutMs: r.timeoutMs };
}

export function policyFingerprint(policy: VerificationPolicy): string {
  return createHash('sha256').update(canonicalPolicy(policy)).digest('hex').slice(0, 16);
}

export interface PolicyDiff {
  changed: boolean;
  added: string[];
  removed: string[];
  modified: string[];
  /**
   * Required checks that were removed, made optional, or had their command changed; plus
   * `authority` when the candidate moves the test gate from local to CI.
   */
  weakened: string[];
  /** The authority change, when the candidate names another one (e.g. "local -> ci"). */
  authority?: string | undefined;
}

/** What a candidate policy does to the effective one. */
export function diffPolicy(
  effective: VerificationPolicy,
  candidate: VerificationPolicy,
): PolicyDiff {
  const before = new Map(effective.commands.map((c) => [c.id, c]));
  const after = new Map(candidate.commands.map((c) => [c.id, c]));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const modified = [...before.keys()].filter((id) => {
    const a = before.get(id);
    const b = after.get(id);
    return a && b && canonicalPolicy({ commands: [a] }) !== canonicalPolicy({ commands: [b] });
  });
  const weakened = [...before.values()]
    .filter((c) => c.required)
    .filter((c) => {
      const next = after.get(c.id);
      if (!next) return true;
      if (!next.required) return true;
      return next.command !== c.command || next.args.join('\0') !== c.args.join('\0');
    })
    .map((c) => c.id);
  const from = authorityOf(effective);
  const to = authorityOf(candidate);
  if (from === 'local' && to === 'ci') weakened.push('authority');
  const regression =
    JSON.stringify(canonicalRegression(effective.regression)) !==
    JSON.stringify(canonicalRegression(candidate.regression));
  return {
    changed: added.length + removed.length + modified.length > 0 || from !== to || regression,
    added,
    removed,
    modified,
    weakened,
    ...(from !== to ? { authority: `${from} -> ${to}` } : {}),
  };
}

/** The persisted shape `isValidRun` needs; matches the storage rows without importing them. */
export interface RunEvidence {
  status: RunStatus;
  head: string;
  tree: string;
  configFingerprint: string;
  completedAt: string | null;
}

export interface Snapshot {
  head: string;
  tree: string;
  dirty: string[];
  configFingerprint: string;
}

/** Why a run is not evidence for `now`, or null when it is. */
export function runInvalidReason(run: RunEvidence, now: Snapshot): string | null {
  if (run.status === 'running') return 'the run did not finish';
  if (run.status === 'interrupted') return 'the run was interrupted';
  if (run.status === 'failed') return 'a required check failed';
  if (run.completedAt === null) return 'the run has no completion time';
  if (now.dirty.length > 0) return `the worktree has uncommitted changes (${now.dirty[0] ?? ''})`;
  if (run.head !== now.head)
    return `it ran at ${run.head.slice(0, 7)}, HEAD is ${now.head.slice(0, 7)}`;
  if (run.tree !== now.tree) return 'the tree differs from the one verified';
  if (run.configFingerprint !== now.configFingerprint) return 'the verification policy changed';
  // A run is `passed` only when every check the policy of that fingerprint required passed.
  return null;
}

export type RegressionStatus = 'passed' | 'not-red' | 'not-green' | 'no-tests' | 'exempt';

/**
 * What a bug job's regression attempt runs, from the job's diff alone (no agent input): `exempt`
 * when every changed path is Markdown, else the added or modified files `classifyChanges` labels
 * `tests` (renamed ones do not count), `no-tests` when there are none.
 */
export function regressionPlan(
  changes: readonly { path: string; status: ChangeStatus }[],
): { status: 'exempt' | 'no-tests'; files: [] } | { status: 'run'; files: string[] } {
  if (changes.length > 0 && changes.every((c) => c.path.endsWith('.md'))) {
    return { status: 'exempt', files: [] };
  }
  const files = classifyChanges(changes)
    .filter((c) => c.kind === 'tests' && (c.status === 'added' || c.status === 'modified'))
    .map((c) => c.path.split('\\').join('/'));
  return files.length > 0 ? { status: 'run', files } : { status: 'no-tests', files: [] };
}
