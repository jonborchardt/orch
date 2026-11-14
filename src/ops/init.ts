/**
 * `orch init`: prepare a repository for the factory by writing a reviewed `factory.json`, and
 * `orch init --check`: report whether the policy the factory will trust is in place. Neither runs
 * a verification command; the trusted baseline stays what `ops/verify.ts` reads from Git.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { UsageError, ValidationError } from '../core/errors.ts';
import { whichSync } from '../core/exec.ts';
import { findProjectRoot } from '../core/paths.ts';
import {
  canonicalPolicy,
  formatPolicy,
  parsePolicy,
  parsePolicyText,
  POLICY_FILE,
  type VerificationPolicy,
} from '../core/verification.ts';
import { baseRef, describeRepo } from '../git/repo.ts';
import { tryGit } from '../git/run.ts';

/** package.json scripts worth proposing, in order. `check` stands in for the three it usually runs. */
const SCRIPTS = ['check', 'test', 'lint', 'typecheck', 'build'];
const COVERED_BY_CHECK = new Set(['test', 'lint', 'typecheck']);

interface RawCheck {
  id: string;
  command: string;
  args: string[];
}

/** `npm run <script>` for each conventional script present. Empty when nothing can be inferred. */
export function suggestFromPackageJson(root: string): RawCheck[] {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return [];
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }
  const present = SCRIPTS.filter((s) => typeof scripts[s] === 'string');
  const picked = present.includes('check')
    ? present.filter((s) => !COVERED_BY_CHECK.has(s))
    : present;
  return picked.map((s) => ({ id: s, command: 'npm', args: ['run', s] }));
}

/** `--command "<id>=<executable> [args...]"`; validation of each part is `parsePolicy`'s. */
export function parseCommandFlag(spec: string): RawCheck {
  const eq = spec.indexOf('=');
  const [command = '', ...args] = spec
    .slice(eq + 1)
    .trim()
    .split(/\s+/);
  if (eq < 1 || command === '') {
    throw new UsageError(
      `--command must look like "<id>=<executable> [args...]", got ${JSON.stringify(spec)}`,
    );
  }
  return { id: spec.slice(0, eq).trim(), command, args };
}

export interface InitInput {
  cwd: string;
  repo?: string | undefined;
  /** `--command` values. */
  commands?: string[] | undefined;
  fromPackageJson?: boolean | undefined;
  force?: boolean | undefined;
}

export interface InitResult {
  repo: string;
  root: string;
  path: string;
  /** An existing file was overwritten (`--force`). */
  replaced: boolean;
  checks: string[];
  next: string[];
}

export function initRepo(input: InitInput): InitResult {
  const info = describeRepo(input.repo ?? input.cwd);
  const target = join(info.root, POLICY_FILE);
  const replaced = existsSync(target);
  if (replaced && !input.force) {
    throw new ValidationError(
      `${target} already exists. Review it (orch init --check), or pass --force to replace it.`,
    );
  }
  let raw: RawCheck[] = (input.commands ?? []).map(parseCommandFlag);
  if (input.fromPackageJson) raw = [...suggestFromPackageJson(info.root), ...raw];
  if (raw.length === 0) {
    const suggested = suggestFromPackageJson(info.root);
    const offer = suggested.length
      ? `package.json suggests: ${describe(suggested).join('; ')}. Accept them with --from-package-json, or`
      : 'No verification commands could be inferred from this repository;';
    throw new UsageError(
      `${offer} specify each check with --command "<id>=<executable> [args...]" ` +
        '(for example --command "test=npm run test"). Nothing was written.',
    );
  }
  const policy = parsePolicy({ verification: { commands: raw } });
  writeAtomically(target, formatPolicy(policy));
  const push = tryGit(info.root, 'remote', 'get-url', 'origin') ? ' && git push' : '';
  return {
    repo: info.identity,
    root: info.root,
    path: target,
    replaced,
    checks: describe(policy.commands),
    next: [
      `Review ${POLICY_FILE}: each check is an executable on PATH plus an argument array, run in order from the repository root in a clean worktree; add "cwd", "required": false, or "timeoutMs" where needed.`,
      `Commit it on the branch factory jobs will start from: git add ${POLICY_FILE} && git commit -m "Add factory verification policy"${push}`,
      'Confirm readiness: orch init --check',
      'Start a job: /factory <request> in Claude Code, or orch factory start --title <t> --session <name>',
    ],
  };
}

function describe(checks: readonly RawCheck[]): string[] {
  return checks.map((c) => `${c.id}: ${[c.command, ...c.args].join(' ')}`);
}

/** Write via a sibling temp file and rename, so a failure never leaves a partial factory.json. */
function writeAtomically(target: string, text: string): void {
  const tmp = `${target}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: 'wx' });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new ValidationError(`Could not write ${target}: ${(err as Error).message}`);
  }
}

export type ReadinessStatus =
  | 'no-git-repository'
  | 'missing'
  | 'invalid'
  | 'ignored'
  | 'uncommitted'
  | 'unpushed'
  | 'unconfigured'
  | 'missing-tools'
  | 'ready';

export interface Readiness {
  status: ReadinessStatus;
  ready: boolean;
  root: string | null;
  path: string | null;
  /** Ref a job started here would read its baseline policy from (`origin/<branch>` or `<branch>`). */
  baseRef: string | null;
  checks: string[];
  missingTools: string[];
  detail: string;
  next: string | null;
}

/** Read-only: is the policy the factory would trust committed, valid, and runnable here? */
export function checkReadiness(cwd: string, repo?: string): Readiness {
  const where = repo ?? cwd;
  const root = findProjectRoot(where);
  const base: Readiness = {
    status: 'no-git-repository',
    ready: false,
    root: root ?? null,
    path: root ? join(root, POLICY_FILE) : null,
    baseRef: null,
    checks: [],
    missingTools: [],
    detail: `${where} is not inside a Git repository.`,
    next: 'Run orch init inside a Git repository, or pass --repo <path>.',
  };
  if (!root) return base;
  const file = join(root, POLICY_FILE);
  const at = (status: ReadinessStatus, detail: string, next: string | null): Readiness => ({
    ...base,
    status,
    detail,
    next,
  });
  if (!existsSync(file)) {
    return at('missing', `${file} does not exist.`, 'Run orch init --command ... to create it.');
  }
  let policy: VerificationPolicy;
  try {
    policy = parsePolicyText(readFileSync(file, 'utf8'));
  } catch (err) {
    return at('invalid', (err as Error).message, `Fix ${POLICY_FILE} and commit the correction.`);
  }
  base.checks = policy.commands.map((c) => `${c.id}${c.required ? '' : ' (optional)'}`);
  if (tryGit(root, 'check-ignore', '-q', POLICY_FILE) !== undefined) {
    return at(
      'ignored',
      `${POLICY_FILE} is ignored by Git, so it can never become the trusted policy.`,
      `Remove the ignore rule and commit ${POLICY_FILE}.`,
    );
  }
  const commit = `git add ${POLICY_FILE} && git commit -m "Add factory verification policy"`;
  if (tryGit(root, 'status', '--porcelain', '--', POLICY_FILE) !== '') {
    return at('uncommitted', `${POLICY_FILE} has uncommitted changes.`, commit);
  }
  const { currentBranch } = describeRepo(root);
  const ref = baseRef(root, currentBranch) ?? 'HEAD';
  base.baseRef = ref;
  const committed = tryGit(root, 'show', `${ref}:${POLICY_FILE}`);
  let same = false;
  if (committed !== undefined) {
    try {
      const trusted = parsePolicyText(committed, `${POLICY_FILE} at ${ref}`);
      same = canonicalPolicy(trusted) === canonicalPolicy(policy);
    } catch (err) {
      return at('invalid', (err as Error).message, `Fix ${POLICY_FILE}, commit, and push.`);
    }
  }
  if (!same) {
    return ref.startsWith('origin/')
      ? at(
          'unpushed',
          `${POLICY_FILE} differs from ${ref}, which is where a job started from ${currentBranch} reads its policy.`,
          `git push origin ${currentBranch}`,
        )
      : at('uncommitted', `${POLICY_FILE} is not committed on ${currentBranch}.`, commit);
  }
  if (policy.commands.length === 0) {
    return at(
      'unconfigured',
      `${POLICY_FILE} at ${ref} declares no verification commands; jobs would stop at configuration-required.`,
      'Add at least one check (orch init --force --command ...), commit, and push.',
    );
  }
  base.missingTools = [...new Set(policy.commands.map((c) => c.command))].filter(
    (c) => whichSync(c) === undefined,
  );
  if (base.missingTools.length > 0) {
    return at(
      'missing-tools',
      `Not on PATH: ${base.missingTools.join(', ')}. Checks would fail to start on this machine.`,
      'Install the missing tools or change the commands.',
    );
  }
  return {
    ...base,
    status: 'ready',
    ready: true,
    detail: `${String(policy.commands.length)} check(s) committed at ${ref}: ${base.checks.join(', ')}.`,
    next: null,
  };
}
