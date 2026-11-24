/**
 * What the foreground factory controller (`orch start`) keeps outside the database: who holds the
 * controller, what the session was asked to do, and whether a stop was requested. Job stage,
 * ticket status, CI, and merge evidence stay where they are; nothing here repeats them.
 *
 * Kept under the data directory (`runnerPaths`), each with one writer: the lock (generations
 * taken by exclusive creation, see `acquireRunnerLock`), the session record (that controller, replaced atomically),
 * and the two stop requests (`orch stop`). A heartbeat can therefore never overwrite a stop.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { processStartMs } from '../core/exec.ts';
import { runnerPaths, type RuntimePaths } from '../core/paths.ts';
import { freshRecord } from './recover.ts';
import { inRepositoryAt } from './repo.ts';
import { alive, sleep } from './verify-lock.ts';

export const TICKET_OUTCOMES = [
  'done',
  'needs-human',
  'blocked',
  'refused',
  'claimed',
  'stopped',
] as const;
/**
 * `done`: the ticket's lifecycle says done (a verified merge closed it, now or earlier).
 * `needs-human`: its job waits for a person, in needs-human or completed with a merge only a
 * person can unblock (`personMergeStep` in core/workflow.ts). `blocked`: started, and cannot go
 * on without one (cancelled, unverified merge, a budget spent). `refused`: nothing was started.
 * `claimed`: another process created the ticket's job first. `stopped`: `orch stop` interrupted it.
 * In a queue run every outcome but `done` and `stopped` passes the ticket over for the session,
 * unless its `code` is one of `RUN_ENDING_CODES` (core/workflow.ts), which ends the run.
 */
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];

export interface TicketResult {
  ticketId: number;
  title: string;
  repo: string;
  /** The job that was run or merged last; null when none was created. */
  jobId: string | null;
  outcome: TicketOutcome;
  /** Which budget or refusal stopped it (the `runner.stopped` code); absent in older records. */
  code?: string | undefined;
  reason: string;
  /** Re-land jobs run for it in this session. */
  relands: number;
  /** What a person does about it, when something is left to do. */
  next: string | null;
}

export interface RunnerSession {
  pid: number;
  startedAt: string;
  beatAt: string;
  /** `queue`: `orch start`. `ticket`: `orch do <id>`. */
  mode: 'queue' | 'ticket';
  /** Queue scope: the root of the one repository, or null for every repository. */
  repo: string | null;
  /** The ticket `orch do` was given. */
  ticket: number | null;
  /**
   * `orch do --fast`: a job the controller creates for that ticket is a fast job. Absent in
   * records written before fast mode; kept across `orch resume`.
   */
  fast?: boolean | undefined;
  /** The ticket and job in flight. */
  ticketId: number | null;
  /**
   * How the queue took the ticket in flight: `resume` a stranded in-progress one, or `ready` a new
   * one. Null for `orch do` and between tickets; absent in older records.
   */
  pick?: 'resume' | 'ready' | null | undefined;
  jobId: string | null;
  /** The Claude process started for that job, until its exit was seen. */
  child: { pid: number; startedAt: string } | null;
  results: TicketResult[];
  /** Tickets passed over without an attempt, with why. */
  skipped: { ticketId: number; reason: string }[];
  /** Set when the session ended on its own terms; an interrupted session has none. */
  finished: { at: string; reason: string } | null;
}

const bootMs = (nowMs: number) => nowMs - uptime() * 1000;

export function readSession(paths: RuntimePaths): RunnerSession | null {
  try {
    const s = JSON.parse(readFileSync(runnerPaths(paths).state, 'utf8')) as RunnerSession;
    return typeof s.pid === 'number' && typeof s.startedAt === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** Replace the session record in one step: a reader sees the old record or the new one. */
export function writeSession(paths: RuntimePaths, session: RunnerSession): void {
  const file = runnerPaths(paths).state;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2) + '\n');
  // Windows refuses the rename while a reader has the target open; that lasts milliseconds.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 20) throw err;
      sleep(25);
    }
  }
}

interface LockRecord {
  pid: number;
  startedAt: string;
  /** The holder gave the lock up (it may still be running, as in tests). */
  released?: boolean;
}

const lockFile = (paths: RuntimePaths, generation: number) =>
  join(runnerPaths(paths).lock, String(generation));

/** The highest lock generation taken so far; 0 when there is none. */
function topGeneration(paths: RuntimePaths): number {
  let names: string[];
  try {
    names = readdirSync(runnerPaths(paths).lock);
  } catch {
    return 0;
  }
  return Math.max(0, ...names.map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

/** The live controller holding `generation`, or null when its holder is gone or gave it up. */
function holderOf(paths: RuntimePaths, generation: number): LockRecord | null {
  let rec: Partial<LockRecord>;
  try {
    rec = JSON.parse(readFileSync(lockFile(paths, generation), 'utf8')) as Partial<LockRecord>;
  } catch {
    return null; // generations appear whole (linked into place), so this one is damaged
  }
  const { pid, startedAt } = rec;
  if (typeof pid !== 'number' || typeof startedAt !== 'string' || rec.released === true)
    return null;
  if (!alive(pid)) return null;
  const session = readSession(paths);
  const beatAt = session?.pid === pid ? session.beatAt : undefined;
  const nowMs = Date.now();
  return freshRecord({ pid, startedAt, beatAt }, nowMs, bootMs(nowMs)) ? { pid, startedAt } : null;
}

/**
 * The PID of the live controller, or null. The holder of the highest generation is the only
 * candidate; it is stale when its process is gone, it predates the last boot, it released the
 * lock, or its session has not beaten for HEARTBEAT_STALE_SECONDS (a reused PID).
 */
export function controllerPid(paths: RuntimePaths): number | null {
  const top = topGeneration(paths);
  return top === 0 ? null : (holderOf(paths, top)?.pid ?? null);
}

/** The release function of a held lock; `owned()` says whether its generation is still the top. */
export type RunnerLock = (() => void) & { owned(): boolean };

/**
 * Become the one controller, or throw while a live one exists. Returns the release function,
 * with `owned()`: false once a higher generation exists, which is for good (numbers only grow).
 *
 * The lock is a sequence of generations, `<data>/runner-lock/<n>`. A starter that finds
 * generation n stale takes over by creating n + 1, and creating a file that already exists
 * fails: of any number of starters judging the same stale lock, exactly one gets the next
 * generation, and the others find a live holder when they look again. Nothing is ever removed
 * or overwritten by a competitor, so there is no moment at which a fresh lock can be taken away.
 *
 * ponytail: one small file per controller session is kept for good. Removing old generations
 * would free their numbers for a starter still acting on an earlier look; prune only with a
 * rule that cannot do that.
 */
export function acquireRunnerLock(paths: RuntimePaths): RunnerLock {
  const dir = runnerPaths(paths).lock;
  mkdirSync(dir, { recursive: true });
  const mine: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
  // Written in full first and linked into place, so a generation is never seen half written.
  const tmp = join(dir, `tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(mine));
  try {
    for (;;) {
      const top = topGeneration(paths);
      const holder = top === 0 ? null : holderOf(paths, top);
      if (holder !== null) {
        throw new ValidationError(
          `A factory controller is already running (PID ${String(holder.pid)}). ` +
            'See orch status; stop it with orch stop next or orch stop.',
        );
      }
      const generation = top + 1;
      const file = lockFile(paths, generation);
      try {
        linkSync(tmp, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        continue; // another starter took this generation: look at it
      }
      const release = () => {
        // Only the holder replaces its own generation, and in one step.
        const done = `${tmp}-released`;
        writeFileSync(done, JSON.stringify({ ...mine, released: true }));
        renameSync(done, file);
      };
      return Object.assign(release, { owned: () => topGeneration(paths) === generation });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface StopRequests {
  /** Finish the current ticket, then exit (`orch stop next`). */
  next: boolean;
  /** End the current execution now, leaving the job resumable (`orch stop`). */
  now: boolean;
}

export function stopRequests(paths: RuntimePaths): StopRequests {
  const files = runnerPaths(paths);
  return { next: existsSync(files.stopNext), now: existsSync(files.stopNow) };
}

export function requestStop(paths: RuntimePaths, which: keyof StopRequests): void {
  const files = runnerPaths(paths);
  const file = which === 'next' ? files.stopNext : files.stopNow;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, new Date().toISOString() + '\n');
}

export function clearStop(paths: RuntimePaths, which: keyof StopRequests): void {
  const files = runnerPaths(paths);
  rmSync(which === 'next' ? files.stopNext : files.stopNow, { force: true });
}

/**
 * Whether the Claude process a dead controller left behind may still be running, from the PID
 * and the boot time only, so a reused PID reads as alive. Cheap: `runnerStatus` uses it; resume
 * and stop decide with `childIdentity`, which also asks the OS when that PID started.
 */
export function childMayBeAlive(session: RunnerSession, nowMs = Date.now()): boolean {
  const child = session.child;
  if (!child || !alive(child.pid)) return false;
  const started = Date.parse(child.startedAt);
  return Number.isNaN(started) || started >= bootMs(nowMs) - 60_000;
}

/**
 * How far the OS start time may sit before the recorded `startedAt` (taken just before the
 * spawn) and still be the child: POSIX `ps` reports whole seconds, and the OS process clock can
 * differ from `Date.now()` by a little.
 */
export const START_SLACK_BEFORE_MS = 10_000;
/** How far after `startedAt` it may sit: the spawn itself can be delayed on a loaded machine. */
export const START_SLACK_AFTER_MS = 60_000;

/**
 * `original`: the live process started when the child was launched. `reused`: it started at
 * another time, so it is another program on the same PID. `unknown`: no start time was read.
 */
export function classifyStart(
  recordedMs: number,
  observedMs: number | null,
): 'original' | 'reused' | 'unknown' {
  if (observedMs === null || !Number.isFinite(recordedMs)) return 'unknown';
  return observedMs >= recordedMs - START_SLACK_BEFORE_MS &&
    observedMs <= recordedMs + START_SLACK_AFTER_MS
    ? 'original'
    : 'reused';
}

/**
 * Whether the recorded child is still the process at its PID. `gone` and `reused` let resume
 * and stop go ahead; `original` and `unknown` refuse. Never signals the process.
 */
export function childIdentity(
  session: RunnerSession,
  startTime: (pid: number) => number | null = processStartMs,
  nowMs = Date.now(),
): 'gone' | 'original' | 'reused' | 'unknown' {
  const child = session.child;
  if (!child || !childMayBeAlive(session, nowMs)) return 'gone';
  return classifyStart(Date.parse(child.startedAt), startTime(child.pid));
}

/**
 * A needs-human result the queue takes again in the same session once a person moves its job on
 * (decision 2026-11-24-default-needs-human-choices): an escalation (code `needs-human`; older
 * records carry no code), never a merge only a person can make (`personMergeStep` codes).
 */
export function awaitsPerson(r: TicketResult): boolean {
  return r.outcome === 'needs-human' && (r.code ?? 'needs-human') === 'needs-human';
}

/**
 * Whether the running queue controller takes the job's ticket again once a person acts on it:
 * a live controller in queue mode, whose repository filter covers the job, whose session passed
 * the ticket over as `awaitsPerson`. Read-only; the dashboard's after-action line asks this.
 */
export function controllerContinues(
  paths: RuntimePaths,
  job: { ticketId: number | null; repo: string; repoPath: string },
): boolean {
  if (job.ticketId === null || controllerPid(paths) === null) return false;
  const s = readSession(paths);
  if (s?.finished !== null || s.mode === 'ticket') return false;
  if (!s.results.some((r) => r.ticketId === job.ticketId && awaitsPerson(r))) return false;
  try {
    return s.repo === null || inRepositoryAt(s.repo)(job);
  } catch {
    return false; // the filtered checkout is gone: nothing can say it covers the job
  }
}
