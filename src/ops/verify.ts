/**
 * `orch verify`: run the repository's verification policy inside the job worktree and record the
 * evidence, plus the questions the gates ask of it (which policy applies, is the latest run still
 * valid for HEAD). The policy comes from the merge base (code the job did not write) unless a
 * human authorized the worktree's own factory.json through the dashboard.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { spawnCommand, type ToolResult } from '../core/exec.ts';
import {
  type FailedTest,
  type Flake,
  flakeKey,
  flakeReason,
  type FlakeRule,
  flakeView,
  FLAKY_EVENT,
  integrateFirstAdvice,
  normalisePath,
  parseFailures,
  passedOnRerun,
  shareFlakes,
  unchangedFile,
} from '../core/flake.ts';
import { canonicalPath, jobArtifactDir, verifyLockPath, verifyQueueDir } from '../core/paths.ts';
import {
  buildReport,
  classifyPath,
  policyScriptPaths,
  scanDiff,
  type SensitiveReport,
} from '../core/sensitive.ts';
import {
  type Authority,
  authorityOf,
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
import { now, TERMINAL_STATUSES } from '../core/workflow.ts';
import { git, tryGit } from '../git/run.ts';
import type { Store } from '../storage/client.ts';
import { latestEventsByJob } from '../storage/events.ts';
import { type Auth, authorize, getJob, listJobs, renewLease } from '../storage/jobs.ts';
import type { Job, VerificationCheck, VerificationRun } from '../storage/schema.ts';
import {
  type CheckResult,
  finishRun,
  latestRun,
  latestRunsByJob,
  listChecks,
  listRuns,
  markFlaky,
  recordCheck,
  type RunDetail,
  startRun,
} from '../storage/verification.ts';
import { requireClean, type Tree, worktreeOf } from './tree.ts';
import { acquireVerifyLock, type VerifyQueueState, verifyQueueState } from './verify-lock.ts';

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

/**
 * factory.json text by worktree and full commit id, for this process only (the CLI exits after one
 * command; the dashboard keeps it while it runs). A commit id names its content, so the file at
 * <worktree, sha> cannot change; every gate asks for the merge-base and HEAD policies, and this
 * spares the repeated `git show`. Only files that were found are kept: "absent" and "git failed"
 * look the same here, so neither is remembered.
 */
const policyText = new Map<string, string>();

/** The policy committed at `sha` (a commit, not a ref name); empty when the file is absent. */
export function policyAt(wt: string, sha: string): VerificationPolicy {
  const key = /^[0-9a-f]{40}$/.test(sha) ? `${canonicalPath(wt)}\0${sha}` : null;
  let text = key ? policyText.get(key) : undefined;
  if (text === undefined) {
    text = tryGit(wt, 'show', `${sha}:${POLICY_FILE}`);
    if (text !== undefined && key) policyText.set(key, text);
  }
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
    /** Which run is the authoritative test gate (decision 2026-11-22-ci-authoritative-verification). */
    authority: Authority;
    authorization: SensitiveReport['authorization'];
    candidateError: string | null;
  };
  /** Latest run, if any. */
  run: (VerificationRun & { checks: VerificationCheck[] }) | null;
  /** Whether that run is evidence for the current HEAD and policy. */
  valid: boolean;
  reason: string | null;
  /** A run of this job waiting for, or holding, the machine-wide verify lock. Never affects `valid`. */
  queue: VerifyQueueState | null;
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
    reason = runInvalidReason(latest.run, {
      head: wt.head,
      tree,
      dirty: wt.dirty,
      configFingerprint: eff.fingerprint,
    });
  }
  return {
    configured,
    policy: {
      source: eff.source,
      head: eff.head,
      fingerprint: eff.fingerprint,
      checks: eff.policy.commands.map((c) => `${c.id}${c.required ? '' : ' (optional)'}`),
      authority: authorityOf(eff.policy),
      authorization,
      candidateError: eff.candidateError,
    },
    run: latest ? { ...latest.run, checks: latest.checks } : null,
    valid: configured && latest !== undefined && reason === null,
    reason,
    queue: verifyQueueState(verifyLockPath(store.paths), verifyQueueDir(store.paths), job.id),
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
  return buildReport(
    wt.changes,
    scanDiff(diff),
    eff.diff,
    eff.source === 'authorized',
    policyScriptPaths(eff.policy.commands),
  );
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
  /** The latest run was still valid for this clean HEAD and policy, so nothing ran. */
  reused: boolean;
}

/** Keep the head and tail of a long stream; the middle is replaced by a marker. */
export function cap(text: string): { text: string; truncated: boolean } {
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
    r.cleanup ? `descendants: ${describeCleanup(r.cleanup)}` : '',
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
    // A tree that could not be fully stopped is recorded with the check, not silently dropped.
    error:
      r.error ??
      (r.cleanup && (r.cleanup.failed.length > 0 || r.cleanup.error)
        ? `process tree not fully terminated: ${describeCleanup(r.cleanup)}`
        : null),
  };
}

function describeCleanup(c: NonNullable<ToolResult['cleanup']>): string {
  return (
    `killed ${String(c.killed.length)} (${c.killed.join(', ') || 'none'})` +
    (c.failed.length ? `; could not terminate ${c.failed.join(', ')}` : '') +
    (c.error ? `; process table unavailable: ${c.error}` : '')
  );
}

export interface VerifyOptions {
  /** Told once when another verification holds the lock (the CLI prints it to stderr). */
  onWait?: ((message: string) => void) | undefined;
  /** Lock poll interval; tests shorten it. */
  pollMs?: number | undefined;
}

/** Renew a waiting verify's lease this often: well inside the default 30-minute lease. */
const RENEW_EVERY_MS = 5 * 60_000;

/** The job's clean worktree and the policy that governs it now. */
function prepare(store: Store, job: Job) {
  const wt = worktreeOf(job);
  if (!wt)
    throw new ValidationError(`Job ${job.id} has no worktree; run orch worktree create first.`);
  requireClean(wt, 'verification covers committed snapshots only. Commit first.');
  const eff = effectivePolicy(job, wt);
  return { wt, eff, status: verificationStatus(store, job, wt, eff) };
}

/**
 * Run the effective policy in the job's clean worktree and record every step. Checks run one
 * verification at a time per runtime home: this call waits for the lock, renewing the owner's
 * lease (never the token) before and while it waits.
 */
export function verifyJob(
  store: Store,
  id: string,
  auth: Auth,
  opts: VerifyOptions = {},
): VerifyResult {
  const job = authorize(store, id, auth);
  const { wt, eff, status } = prepare(store, job);
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
      reused: false,
    };
  }
  // Nothing changed since a passed run (same clean HEAD, tree, and policy): it is still the
  // evidence every gate would accept, so return it without taking the lock or running again.
  if (status.valid && status.run) {
    return {
      jobId: id,
      status: 'passed',
      runId: status.run.id,
      head: wt.head,
      policy: status.policy,
      checks: status.run.checks,
      hint: null,
      reused: true,
    };
  }
  // A renewal bumps the revision; a caller pinning one follows it.
  const follow = (j: Job): Auth =>
    auth.expectRevision === undefined ? auth : { ...auth, expectRevision: j.revision };
  let owner = renewLease(store, id, auth);
  let renewedAt = Date.now();
  const release = acquireVerifyLock(verifyLockPath(store.paths), {
    jobId: id,
    queueDir: verifyQueueDir(store.paths),
    pollMs: opts.pollMs,
    onWait: (holder) =>
      opts.onWait?.(
        'orch verify: waiting for another verification to finish' +
          (holder
            ? ` (${holder.jobId ? `job ${holder.jobId}, ` : ''}pid ${String(holder.pid)})`
            : '') +
          '; checks run one at a time.',
      ),
    onPoll: () => {
      if (Date.now() - renewedAt < RENEW_EVERY_MS) return;
      owner = renewLease(store, id, follow(owner));
      renewedAt = Date.now();
    },
  });
  try {
    return runPolicy(store, owner, follow(owner), eff.fingerprint);
  } finally {
    release();
  }
}

/** Under the lock: recheck the worktree (it may have moved while waiting), run, and record. */
function runPolicy(store: Store, job: Job, auth: Auth, fingerprint: string): VerifyResult {
  const id = job.id;
  const { wt, eff, status } = prepare(store, job);
  if (eff.fingerprint !== fingerprint) {
    throw new ValidationError(
      'The verification policy changed while waiting for the lock; run orch verify again.',
    );
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
  const unchanged = flagFlakes(store, id, auth, wt, finished, checks);
  const first = checks.find((c) => c.required && c.status !== 'passed' && c.status !== 'pending');
  const behind = wt.behind ?? 0;
  const next =
    unchanged && behind > 0
      ? integrateFirstAdvice(id, behind)
      : 'Fix, commit, and run orch verify again.';
  return {
    jobId: id,
    status: finished.status === 'passed' ? 'passed' : 'failed',
    runId: run.run.id,
    head: wt.head,
    policy: status.policy,
    checks,
    hint: first
      ? `Required check ${first.checkId} ${first.status} (exit ${String(first.exitCode)}); see ${first.outputPath ?? ''}. ${next}`
      : null,
    reused: false,
  };
}

/**
 * Label likely flakes after a run finishes: a failed run whose failing tests are all in files the
 * job did not change, or earlier failed runs at the tree this run just passed. Labels only.
 * Returns whether this failed run is an unchanged-file flake (the caller's integrate-first hint).
 */
function flagFlakes(
  store: Store,
  id: string,
  auth: Auth,
  wt: Tree,
  finished: VerificationRun,
  checks: VerificationCheck[],
): boolean {
  const artifactDir = jobArtifactDir(id, store.paths);
  const failure = (cs: VerificationCheck[]) => {
    const c = cs.find((x) => x.required && x.status !== 'passed' && x.status !== 'pending');
    if (!c) return { check: '', tests: [] as FailedTest[], cwd: '.' };
    let tests: FailedTest[] = [];
    if (c.outputPath) {
      try {
        tests = parseFailures(
          readFileSync(path.join(artifactDir, ...c.outputPath.split('/')), 'utf8'),
        );
      } catch {
        /* no saved log: the label names the check */
      }
    }
    return { check: c.checkId, tests, cwd: c.cwd };
  };
  const flag = (
    run: VerificationRun,
    f: ReturnType<typeof failure>,
    rule: FlakeRule,
    why: string,
  ) =>
    markFlaky(store, id, auth, {
      runId: run.id,
      head: run.head,
      tree: run.tree,
      check: f.check,
      tests: f.tests,
      rule,
      reason: flakeReason(run, f.check, f.tests, why),
    });
  if (finished.status === 'failed') {
    const f = failure(checks);
    const changed = wt.changes.map((c) => c.path);
    if (!unchangedFile(f.tests, f.cwd, changed)) return false;
    const file = normalisePath(f.cwd, f.tests[0]?.file ?? '') ?? '';
    const key = flakeKey(f);
    const others = [...currentFlakes(store)]
      .filter(([j, x]) => j !== id && flakeKey(x) === key)
      .map(([j]) => j);
    const shared = others.length
      ? `; the same test also failed in ${others.join(', ')}, likely machine-wide`
      : '';
    flag(finished, f, 'unchanged-file', `the job did not change ${file}${shared}`);
    return true;
  }
  for (const r of listRuns(store.db, id)) {
    if (!passedOnRerun(r, finished)) continue;
    const why = `run ${String(finished.id)} passed at the same tree`;
    flag(r, failure(listChecks(store.db, r.id)), 'passed-on-rerun', why);
  }
  return false;
}

/**
 * Every unfinished job's shown flag (none once a newer run passed), with `sharedWith` filled
 * across jobs so one test failing in several jobs reads as one machine-wide cause.
 */
export function currentFlakes(store: Store): Map<string, Flake> {
  const live = listJobs(store.db).filter((j) => !TERMINAL_STATUSES.includes(j.status));
  const ids = live.map((j) => j.id);
  const flags = latestEventsByJob(store.db, ids, [FLAKY_EVENT]);
  const passed = latestRunsByJob(store.db, ids, 'passed');
  const out = new Map<string, Flake>();
  for (const j of live) {
    const view = flakeView(j, flags.get(j.id)?.get(FLAKY_EVENT), passed.get(j.id)?.id ?? null);
    if (view) out.set(j.id, view);
  }
  return shareFlakes(out);
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
