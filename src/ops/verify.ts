/**
 * `orch verify`: run the repository's verification policy inside the job worktree and record the
 * evidence, plus the questions the gates ask of it (which policy applies, is the latest run still
 * valid for HEAD). The policy comes from the merge base (code the job did not write) unless a
 * human authorized the worktree's own factory.json through the dashboard.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { spawnCommand } from '../core/exec.ts';
import { jobArtifactDir } from '../core/paths.ts';
import { buildReport, classifyPath, scanDiff, type SensitiveReport } from '../core/sensitive.ts';
import {
  diffPolicy,
  OUTPUT_CAP,
  parsePolicyText,
  POLICY_FILE,
  type PolicyDiff,
  policyFingerprint,
  type PolicySource,
  runInvalidReason,
  type VerificationCheckSpec,
  type VerificationPolicy,
} from '../core/verification.ts';
import { now } from '../core/workflow.ts';
import { describeRepo } from '../git/repo.ts';
import { git, tryGit } from '../git/run.ts';
import type { Store } from '../storage/client.ts';
import { type Auth, authorize, getJob } from '../storage/jobs.ts';
import type { Job, VerificationCheck, VerificationRun } from '../storage/schema.ts';
import {
  type CheckResult,
  finishRun,
  latestRun,
  recordCheck,
  type RunDetail,
  startRun,
} from '../storage/verification.ts';
import { requireClean, type Tree, worktreeOf } from './tree.ts';

export interface EffectivePolicy {
  policy: VerificationPolicy;
  source: PolicySource;
  /** Commit the policy was read from (merge base, or the authorized head). */
  head: string | null;
  fingerprint: string;
  /** The worktree's own factory.json at HEAD, when it differs from the effective policy. */
  diff: PolicyDiff | null;
  /** The worktree's factory.json could not be parsed. */
  candidateError: string | null;
  mergeBase: string | null;
}

function policyAt(wt: string, sha: string): VerificationPolicy {
  const text = tryGit(wt, 'show', `${sha}:${POLICY_FILE}`);
  if (text === undefined) return { commands: [] };
  return parsePolicyText(text, `${POLICY_FILE} at ${sha.slice(0, 7)}`);
}

/** Which policy governs this job right now, and whether HEAD proposes a different one. */
export function effectivePolicy(job: Job, wt: Tree): EffectivePolicy {
  const base = wt.baseRef;
  const mergeBase = base ? (tryGit(wt.path, 'merge-base', base, 'HEAD') ?? null) : null;
  let policy: VerificationPolicy;
  let source: PolicySource;
  let head: string | null;
  if (job.policy) {
    policy = job.policy;
    source = 'authorized';
    head = job.policyHead;
  } else {
    if (!mergeBase) throw new ValidationError(`Base branch ${job.baseBranch} not found.`);
    policy = policyAt(wt.path, mergeBase);
    source = 'baseline';
    head = mergeBase;
  }
  const fingerprint = policyFingerprint(policy);
  let diff: PolicyDiff | null = null;
  let candidateError: string | null = null;
  try {
    const candidate = policyAt(wt.path, wt.head);
    const d = diffPolicy(policy, candidate);
    // A reordering changes the fingerprint (and so what a run proves) without changing any check.
    if (d.changed || policyFingerprint(candidate) !== fingerprint) diff = { ...d, changed: true };
  } catch (err) {
    candidateError = (err as Error).message;
    diff = { changed: true, added: [], removed: [], modified: [], weakened: [] };
  }
  return { policy, source, head, fingerprint, diff, candidateError, mergeBase };
}

/** The worktree's factory.json at HEAD, parsed, for a human to accept. */
export function candidatePolicy(wt: Tree): VerificationPolicy {
  return policyAt(wt.path, wt.head);
}

export interface VerificationStatus {
  configured: boolean;
  policy: {
    source: PolicySource;
    head: string | null;
    fingerprint: string;
    checks: string[];
    authorization: SensitiveReport['authorization'];
    candidateError: string | null;
  };
  /** Latest run, if any. */
  run: (VerificationRun & { checks: VerificationCheck[] }) | null;
  /** Whether that run is evidence for the current HEAD and policy. */
  valid: boolean;
  reason: string | null;
}

/** Evaluate the latest run against the worktree as it is now. Read-only. */
export function verificationStatus(
  store: Store,
  job: Job,
  wt: Tree,
  eff: EffectivePolicy = effectivePolicy(job, wt),
): VerificationStatus {
  const latest = latestRun(store.db, job.id);
  const tree = tryGit(wt.path, 'rev-parse', 'HEAD^{tree}') ?? '';
  const configured = eff.policy.commands.length > 0;
  const authorization = eff.diff
    ? 'required'
    : eff.source === 'authorized'
      ? 'authorized'
      : 'not-needed';
  let reason: string | null = 'no verification run recorded';
  if (!configured) reason = `no verification commands configured (${POLICY_FILE})`;
  else if (latest) {
    reason = runInvalidReason(
      { ...latest.run, checks: latest.checks },
      {
        head: wt.head,
        tree,
        dirty: wt.dirty,
        configFingerprint: eff.fingerprint,
        requiredIds: eff.policy.commands.filter((c) => c.required).map((c) => c.id),
      },
    );
  }
  return {
    configured,
    policy: {
      source: eff.source,
      head: eff.head,
      fingerprint: eff.fingerprint,
      checks: eff.policy.commands.map((c) => `${c.id}${c.required ? '' : ' (optional)'}`),
      authorization,
      candidateError: eff.candidateError,
    },
    run: latest ? { ...latest.run, checks: latest.checks } : null,
    valid: configured && latest !== undefined && reason === null,
    reason,
  };
}

/** Sensitive-path report for the job's diff against its base. */
export function sensitiveReport(wt: Tree, eff: EffectivePolicy): SensitiveReport {
  const testFiles = wt.changes
    .filter((c) => c.status !== 'deleted' && classifyPath(c.path)?.kind === 'tests')
    .map((c) => c.path);
  const diff =
    wt.baseRef && testFiles.length > 0
      ? (tryGit(wt.path, 'diff', `${wt.baseRef}...HEAD`, '--', ...testFiles) ?? '')
      : '';
  return buildReport(wt.changes, scanDiff(diff), eff.diff, eff.source === 'authorized');
}

export interface VerifyResult {
  jobId: string;
  status: 'passed' | 'failed' | 'configuration-required';
  runId: number | null;
  head: string;
  policy: VerificationStatus['policy'];
  checks: VerificationCheck[];
  /** What the coordinator should do when the result is not `passed`. */
  hint: string | null;
}

/** Keep the head and tail of a long stream; the middle is replaced by a marker. */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= OUTPUT_CAP) return { text, truncated: false };
  const half = Math.floor(OUTPUT_CAP / 2);
  const dropped = text.length - 2 * half;
  return {
    text: `${text.slice(0, half)}\n\n[... ${String(dropped)} characters truncated by orch ...]\n\n${text.slice(-half)}`,
    truncated: true,
  };
}

/** Resolve a check's cwd under the worktree; links that lead outside it are refused. */
function resolveCwd(wtPath: string, rel: string): string {
  const root = realpathSync.native(wtPath);
  const abs = path.resolve(root, rel);
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    throw new Error(`cwd ${rel} does not exist in the worktree`);
  }
  const inside = real === root || real.startsWith(root + path.sep);
  if (!inside) throw new Error(`cwd ${rel} resolves outside the worktree`);
  if (!statSync(real).isDirectory()) throw new Error(`cwd ${rel} is not a directory`);
  return real;
}

function runCheck(spec: VerificationCheckSpec, wtPath: string, logFile: string): CheckResult {
  const startedAt = now();
  const t0 = Date.now();
  let r;
  let cwd: string | undefined;
  try {
    cwd = resolveCwd(wtPath, spec.cwd);
    r = spawnCommand(spec.command, spec.args, { cwd, timeout: spec.timeoutMs });
  } catch (err) {
    r = { status: null, stdout: '', stderr: '', signal: null, error: (err as Error).message };
  }
  const durationMs = Date.now() - t0;
  const out = cap(r.stdout);
  const errOut = cap(r.stderr);
  const status: CheckResult['status'] = r.timedOut
    ? 'timed-out'
    : r.error !== undefined
      ? 'error'
      : r.status === 0
        ? 'passed'
        : 'failed';
  const text = [
    `# orch verify: ${spec.id}`,
    `command: ${JSON.stringify([spec.command, ...spec.args])}`,
    `cwd: ${cwd ?? spec.cwd}`,
    `status: ${status}  exit: ${String(r.status)}  signal: ${String(r.signal ?? null)}  duration: ${String(durationMs)}ms`,
    r.error ? `error: ${r.error}` : '',
    '',
    '--- stdout ---',
    out.text,
    '--- stderr ---',
    errOut.text,
    '',
  ].join('\n');
  mkdirSync(path.dirname(logFile), { recursive: true });
  writeFileSync(logFile, text);
  return {
    status,
    startedAt,
    completedAt: now(),
    durationMs,
    exitCode: r.status,
    signal: r.signal ?? null,
    outputPath: null, // filled by the caller (relative form)
    outputSha256: createHash('sha256').update(text).digest('hex'),
    truncated: out.truncated || errOut.truncated,
    error: r.error ?? null,
  };
}

/** Run the effective policy in the job's clean worktree and record every step. */
export function verifyJob(store: Store, id: string, auth: Auth): VerifyResult {
  const job = authorize(store, id, auth);
  const wt = worktreeOf(job);
  if (!wt) throw new ValidationError(`Job ${id} has no worktree; run orch worktree create first.`);
  if (wt.branch !== job.branch) {
    throw new ValidationError(
      `Worktree is on ${wt.branch ?? '(detached)'} but the job branch is ${job.branch ?? '?'}.`,
    );
  }
  const identity = describeRepo(wt.path).identity;
  if (identity !== job.repo) {
    throw new ValidationError(`Worktree belongs to ${identity}; job ${id} belongs to ${job.repo}.`);
  }
  requireClean(wt, 'verification covers committed snapshots only. Commit first.');
  const eff = effectivePolicy(job, wt);
  const status = verificationStatus(store, job, wt, eff);
  if (!status.configured) {
    return {
      jobId: id,
      status: 'configuration-required',
      runId: null,
      head: wt.head,
      policy: status.policy,
      checks: [],
      hint:
        eff.diff || eff.candidateError
          ? `No verification policy on the base branch. The worktree's ${POLICY_FILE} proposes one; ` +
            'a human can accept it from the dashboard (accept-policy), or add it to the base branch.'
          : `No verification policy: add a ${POLICY_FILE} to the repository base branch (orch init, ` +
            'review, commit, push), or propose one in the worktree for a human to accept.',
    };
  }
  const tree = git(wt.path, 'rev-parse', 'HEAD^{tree}');
  const run = startRun(store, id, {
    ...auth,
    head: wt.head,
    tree,
    dirty: wt.dirty,
    configFingerprint: eff.fingerprint,
    policySource: eff.source,
    policyHead: eff.head,
    checks: eff.policy.commands,
  });
  const artifactDir = jobArtifactDir(id, store.paths);
  const checks: VerificationCheck[] = [];
  let failed = false;
  for (const row of run.checks) {
    const spec = eff.policy.commands.find((c) => c.id === row.checkId);
    if (!spec || failed) {
      checks.push(row);
      continue;
    }
    const rel = `verification/${String(run.run.id)}/${row.checkId}.log`;
    const result = runCheck(spec, wt.path, path.join(artifactDir, ...rel.split('/')));
    result.outputPath = rel;
    // A revoked token here throws and leaves the run `running`, which is never evidence.
    checks.push(recordCheck(store, id, auth, row.id, result));
    if (spec.required && result.status !== 'passed') failed = true;
  }
  const finished = finishRun(store, id, auth, run.run.id, failed ? 'failed' : 'passed');
  const first = checks.find((c) => c.required && c.status !== 'passed' && c.status !== 'pending');
  return {
    jobId: id,
    status: finished.status === 'passed' ? 'passed' : 'failed',
    runId: run.run.id,
    head: wt.head,
    policy: status.policy,
    checks,
    hint: first
      ? `Required check ${first.checkId} ${first.status} (exit ${String(first.exitCode)}); see ${first.outputPath ?? ''}. Fix, commit, and run orch verify again.`
      : null,
  };
}

/** Read-only view for `orch verify show` and the plan. */
export function showVerification(store: Store, id: string): VerificationStatus | null {
  const job = getJob(store.db, id);
  const wt = worktreeOf(job);
  if (!wt?.baseRef) return null;
  return verificationStatus(store, job, wt);
}

export function latestValidRun(store: Store, job: Job, wt: Tree): RunDetail | undefined {
  const s = verificationStatus(store, job, wt);
  return s.valid && s.run ? { run: s.run, checks: s.run.checks } : undefined;
}
