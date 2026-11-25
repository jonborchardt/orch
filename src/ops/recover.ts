/**
 * The opt-in recovery worker (decision 2026-11-16-opt-in-recovery-worker). A pass probes GitHub,
 * classifies every unfinished job (`core/recovery.ts`), and continues each recoverable ci-stage job
 * in one short ownership episode as `orch-recovery`: resume (never forced), start, one
 * `reconcileCi`, release. It never launches, messages, or replaces a Claude session, never removes
 * a worktree, and never runs anything that changes a worktree's files.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { waitSeconds } from '../core/ci.ts';
import { ToolError, ValidationError } from '../core/errors.ts';
import { recoveryPaths, type RuntimePaths } from '../core/paths.ts';
import {
  classifyJob,
  failureStreak,
  RECOVERY_EXHAUSTED_REASON,
  RECOVERY_MAX_FAILURES,
  RECOVERY_SESSION,
  type RecoveryClass,
} from '../core/recovery.ts';
import { sessionLinks } from '../core/session.ts';
import { now, type Stage, type Status, TERMINAL_STATUSES } from '../core/workflow.ts';
import { probeGitHub } from '../integrations/github.ts';
import type { Store } from '../storage/client.ts';
import { listEvents } from '../storage/events.ts';
import {
  claimJob,
  getJob,
  listJobs,
  recordEvent,
  releaseJob,
  sessionsByJob,
} from '../storage/jobs.ts';
import type { Event, Job } from '../storage/schema.ts';
import { launchFor } from './dispatch.ts';
import { resumeFactoryJob } from './factory.ts';
import { transitionGuarded } from './gates.ts';
import { isObservation, reconcileCi } from './github.ts';
import { mailWatermark, reportJobMail } from './mail.ts';
import { alive, sleep } from './verify-lock.ts';

/** Seconds between passes after a successful probe, at least. */
export const PASS_FLOOR_SECONDS = 60;
/** Probe failures back off from this, doubling, up to PROBE_BACKOFF_MAX_SECONDS. */
export const PROBE_BACKOFF_SECONDS = 30;
export const PROBE_BACKOFF_MAX_SECONDS = 600;

export interface RecoveryJob {
  jobId: string;
  title: string;
  stage: Stage;
  status: Status;
  class: RecoveryClass;
  reason: string;
  /** What this pass did to the job. */
  action: 'none' | 'reconciled' | 'failed' | 'escalated';
  /** `orch gh ci`'s action and reason, or the error of a failed attempt. */
  detail: string | null;
  /** For needs-session and exhausted jobs: how a human continues it. */
  resume: string | null;
  /** For ci-stage jobs with checks pending: seconds until the next read is useful. */
  waitSeconds: number | null;
}

export interface RecoveryPass {
  at: string;
  online: boolean;
  probeError: string | null;
  jobs: RecoveryJob[];
  /** Seconds until the next pass (set by the loop; null for a lone pass). */
  nextSeconds: number | null;
}

/** Observations of the job's current CI head, as `planJob` counts them. */
function pollsOf(job: Job, events: readonly Event[]): number {
  return events.filter((e) => isObservation(e, job.ciHead)).length;
}

/** Record a failed attempt as the owner, escalate when the budget is spent, and release. */
function recordFailure(
  store: Store,
  id: string,
  token: string | undefined,
  reason: string,
): RecoveryJob['action'] {
  let tok = token;
  // The episode failed after claiming but before returning the token: renew to get one.
  if (tok === undefined && getJob(store.db, id).ownerSession === RECOVERY_SESSION) {
    tok = claimJob(store, id, { session: RECOVERY_SESSION }).token;
  }
  if (tok === undefined) return 'failed'; // never claimed: nothing of ours to record
  const auth = { token: tok };
  const head = getJob(store.db, id).ciHead;
  recordEvent(store, id, auth, 'recovery.failed', { head, reason });
  let action: RecoveryJob['action'] = 'failed';
  if (failureStreak(listEvents(store.db, id, 1000), head) >= RECOVERY_MAX_FAILURES) {
    transitionGuarded(store, id, 'escalate', {
      ...auth,
      reason: `${RECOVERY_EXHAUSTED_REASON}: ${reason}`,
    });
    action = 'escalated';
  }
  releaseJob(store, id, auth);
  return action;
}

/** One ownership episode for a recoverable job; leaves it unowned unless it finished. */
function episode(store: Store, job: Job, entry: RecoveryJob): void {
  const id = job.id;
  let token: string | undefined;
  try {
    token = resumeFactoryJob(store, id, { session: RECOVERY_SESSION }).token;
    const auth = { token };
    const resumed = getJob(store.db, id);
    recordEvent(store, id, auth, 'recovery.attempted', {
      head: resumed.ciHead,
      status: resumed.status,
      previousOwner: job.ownerSession,
    });
    // A job released while running is still running; only a pending one needs `start`.
    if (resumed.status !== 'running') transitionGuarded(store, id, 'start', auth);
    const r = reconcileCi(store, id, auth);
    entry.action = 'reconciled';
    entry.detail = `${r.action}: ${r.reason}`;
    entry.waitSeconds = r.waitSeconds;
    // Completing the job already released it; anything else hands it back for the next pass.
    if (getJob(store.db, id).ownerToken === token) releaseJob(store, id, auth);
  } catch (err) {
    const reason = (err as Error).message;
    entry.detail = reason;
    try {
      entry.action = recordFailure(store, id, token, reason);
    } catch (again) {
      // Another session took the job meanwhile; it is theirs now.
      entry.action = 'failed';
      entry.detail = `${reason} (not recorded: ${(again as Error).message})`;
    }
  }
}

/**
 * One pass: probe, classify every unfinished job, continue the recoverable ones. `owned` runs
 * before each episode; once it returns false no further episode starts.
 */
export function recoverPass(store: Store, owned?: () => boolean): RecoveryPass {
  const at = now();
  const probeError = probeGitHub();
  const online = probeError === null;
  let lost = false;
  const open = listJobs(store.db).filter(
    (j) => !TERMINAL_STATUSES.includes(j.status) && j.archivedAt === null,
  );
  const sessions = sessionsByJob(
    store.db,
    open.map((j) => j.id),
  );
  const jobs = open.map((job): RecoveryJob => {
    const events = listEvents(store.db, job.id, 1000);
    const c = classifyJob(job, events, at);
    const ref = sessions.get(job.id) ?? null;
    const entry: RecoveryJob = {
      jobId: job.id,
      title: job.title,
      stage: job.stage,
      status: job.status,
      class: c.class,
      reason: c.reason,
      action: 'none',
      detail: null,
      resume:
        c.class === 'needs-session' || c.class === 'exhausted'
          ? ((ref ? sessionLinks(ref).resume : null) ?? launchFor(job).fallback[0] ?? null)
          : null,
      waitSeconds:
        job.stage === 'ci' && job.ciStatus === 'pending' ? waitSeconds(pollsOf(job, events)) : null,
    };
    if (online && c.class === 'recoverable' && !lost) {
      if (owned && !owned()) lost = true;
      else episode(store, job, entry);
    }
    return entry;
  });
  return { at, online, probeError, jobs, nextSeconds: null };
}

/** Seconds before the next pass: backoff while offline, else the shortest CI wait, floored. */
export function nextDelay(
  pass: RecoveryPass,
  backoff: number | null,
): { seconds: number; backoff: number | null } {
  if (!pass.online) {
    const b =
      backoff === null ? PROBE_BACKOFF_SECONDS : Math.min(backoff * 2, PROBE_BACKOFF_MAX_SECONDS);
    return { seconds: b, backoff: b };
  }
  const waits = pass.jobs.flatMap((j) => (j.waitSeconds === null ? [] : [j.waitSeconds]));
  const soonest = waits.length ? Math.min(...waits) : PASS_FLOOR_SECONDS;
  return { seconds: Math.max(PASS_FLOOR_SECONDS, soonest), backoff: null };
}

function record(paths: RuntimePaths, pass: RecoveryPass): void {
  const files = recoveryPaths(paths);
  mkdirSync(dirname(files.status), { recursive: true });
  writeFileSync(files.status, JSON.stringify(pass, null, 2) + '\n');
  mkdirSync(dirname(files.log), { recursive: true });
  const acted = pass.jobs.filter((j) => j.action !== 'none').map((j) => `${j.jobId}=${j.action}`);
  appendFileSync(
    files.log,
    `${pass.at} online=${String(pass.online)} jobs=${String(pass.jobs.length)} ` +
      `acted=${acted.join(',') || 'none'} next=${String(pass.nextSeconds)}s` +
      (pass.probeError ? ` probe="${pass.probeError.replace(/\s+/g, ' ')}"` : '') +
      '\n',
  );
}

const superseded = (): RecoveryPass => ({
  at: now(),
  online: false,
  probeError: 'superseded: another recovery worker holds the PID file',
  jobs: [],
  nextSeconds: null,
});

/**
 * Run passes until `signal` aborts (or once). Each pass writes the status file and one log line.
 * A pass that throws is logged as offline and retried with backoff, so the worker keeps going.
 * `beat` runs after every pass; when it returns false (another worker took the PID file) the
 * loop ends. `owned` is checked before every pass, episode and mail; once false the worker
 * returns unrecorded.
 */
export async function runWorker(
  store: Store,
  opts: {
    once?: boolean | undefined;
    signal?: AbortSignal | undefined;
    beat?: (() => boolean) | undefined;
    owned?: (() => boolean) | undefined;
  } = {},
): Promise<RecoveryPass> {
  const owned = opts.owned;
  let backoff: number | null = null;
  for (;;) {
    // Loop top: runs before the first pass and after every delay (a machine sleep lands here).
    if (owned && !owned()) return superseded();
    let pass: RecoveryPass;
    const mark = mailWatermark(store);
    try {
      pass = recoverPass(store, owned);
    } catch (err) {
      pass = {
        at: now(),
        online: false,
        probeError: (err as Error).message,
        jobs: [],
        nextSeconds: null,
      };
    }
    if (owned && !owned()) return superseded();
    await reportJobMail(store, mark);
    const next = nextDelay(pass, backoff);
    backoff = next.backoff;
    if (!opts.once) pass.nextSeconds = next.seconds;
    record(store.paths, pass);
    if (opts.beat && !opts.beat()) return pass;
    if (opts.once || opts.signal?.aborted) return pass;
    await delay(next.seconds * 1000, undefined, { signal: opts.signal }).catch(() => undefined);
    if (opts.signal?.aborted) return pass;
  }
}

// --- the detached worker's PID file ---------------------------------------------------------

export interface WorkerStatus {
  running: boolean;
  pid: number | null;
  files: { pid: string; status: string; log: string };
  /** The last pass any worker (or `run --once`) recorded, or null. */
  last: RecoveryPass | null;
}

/** What the PID file holds: who, since when, and when its last pass finished. */
export interface PidRecord {
  pid: number;
  startedAt: string;
  beatAt?: string | undefined;
}

/**
 * A worker beats after every pass and sleeps at most PROBE_BACKOFF_MAX_SECONDS between passes;
 * the margin covers a slow pass. A record older than this belongs to a worker that is gone.
 */
export const HEARTBEAT_STALE_SECONDS = PROBE_BACKOFF_MAX_SECONDS + 600;

/** Clock skew tolerated before a future-dated record (clock set back) is treated as stale. */
const FUTURE_SKEW_MS = 60_000;

/**
 * Whether a PID record can still describe a running worker: written since the last boot and
 * beaten recently, and not dated in the future. Otherwise its PID may have been reused.
 */
export function freshRecord(rec: PidRecord, nowMs: number, bootMs: number): boolean {
  const started = Date.parse(rec.startedAt);
  const beat = Date.parse(rec.beatAt ?? rec.startedAt);
  if (Number.isNaN(started) || Number.isNaN(beat)) return false;
  const future = nowMs + FUTURE_SKEW_MS;
  if (started > future || beat > future) return false;
  return started >= bootMs && nowMs - beat <= HEARTBEAT_STALE_SECONDS * 1000;
}

function readPid(file: string): PidRecord | null {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<PidRecord>;
    const { pid, startedAt, beatAt } = rec;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof startedAt !== 'string') return null;
    return { pid, startedAt, beatAt: typeof beatAt === 'string' ? beatAt : undefined };
  } catch {
    return null;
  }
}

function writePid(file: string, rec: PidRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rec));
}

/**
 * A live worker's PID, or null. A PID file whose process is gone, that predates the last boot,
 * or whose heartbeat is older than HEARTBEAT_STALE_SECONDS is stale: its PID is never trusted.
 */
function livePid(paths: RuntimePaths): number | null {
  const rec = readPid(recoveryPaths(paths).pid);
  if (rec === null) return null;
  const nowMs = Date.now();
  const bootMs = nowMs - uptime() * 1000;
  return freshRecord(rec, nowMs, bootMs) && alive(rec.pid) ? rec.pid : null;
}

export function workerStatus(paths: RuntimePaths): WorkerStatus {
  const files = recoveryPaths(paths);
  let last: RecoveryPass | null = null;
  try {
    last = JSON.parse(readFileSync(files.status, 'utf8')) as RecoveryPass;
  } catch {
    /* no pass recorded yet */
  }
  const pid = livePid(paths);
  return { running: pid !== null, pid, files, last };
}

/** Refuse while a live worker other than `self` holds the PID file. */
export function refuseIfRunning(paths: RuntimePaths, self?: number): void {
  const pid = livePid(paths);
  if (pid !== null && pid !== self) {
    throw new ValidationError(
      `A recovery worker is already running (PID ${String(pid)}). Stop it with orch recover stop.`,
    );
  }
}

/**
 * Take the PID file for a foreground worker in this process. `owned` reports whether the file
 * still names this process, writing nothing; `beat` refreshes the heartbeat and returns false once
 * another worker holds the file; `release` removes it while it is still ours.
 */
export function holdPidFile(paths: RuntimePaths): {
  owned: () => boolean;
  beat: () => boolean;
  release: () => void;
} {
  const file = recoveryPaths(paths).pid;
  refuseIfRunning(paths, process.pid);
  const startedAt = now();
  writePid(file, { pid: process.pid, startedAt });
  const ours = () => readPid(file)?.pid === process.pid;
  return {
    owned: ours,
    beat: () => {
      if (!ours()) return false;
      writePid(file, { pid: process.pid, startedAt, beatAt: now() });
      return true;
    },
    release: () => {
      if (ours()) rmSync(file, { force: true });
    },
  };
}

/**
 * Launch `node <entry> recover run` detached, with the caller's environment minus its orch
 * session and token, and record its PID. Refuses while a live worker exists.
 */
export function startWorker(paths: RuntimePaths, entry: string): WorkerStatus {
  if (!entry) throw new ToolError('Cannot locate the orch entry point to start the worker.');
  // ponytail: two `start`s racing between this check and writePid can both launch; the second
  // worker refuses itself when it reads a live PID that is not its own.
  refuseIfRunning(paths);
  const env = { ...process.env };
  delete env['ORCH_TOKEN'];
  delete env['ORCH_SESSION'];
  const child = spawn(process.execPath, [entry, 'recover', 'run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  if (child.pid === undefined) throw new ToolError('Could not start the recovery worker.');
  child.unref();
  writePid(recoveryPaths(paths).pid, { pid: child.pid, startedAt: now() });
  return workerStatus(paths);
}

/**
 * Stop the worker if one is running and remove its PID file. A stale PID file is only removed:
 * its PID is never signalled.
 */
export function stopWorker(paths: RuntimePaths): { stopped: boolean; pid: number | null } {
  const file = recoveryPaths(paths).pid;
  const pid = livePid(paths);
  if (pid !== null) {
    process.kill(pid);
    for (let i = 0; i < 100 && alive(pid); i++) sleep(100);
    if (alive(pid)) throw new ToolError(`Recovery worker PID ${String(pid)} did not stop.`);
  }
  rmSync(file, { force: true });
  return { stopped: pid !== null, pid };
}
