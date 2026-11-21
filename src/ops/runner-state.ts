/**
 * What the foreground factory controller (`orch start`) keeps outside the database: who holds the
 * controller, what the session was asked to do, and whether a stop was requested. Job stage,
 * ticket status, CI, and merge evidence stay where they are; nothing here repeats them.
 *
 * Four files under the data directory (`runnerPaths`), each with one writer: the lock (the live
 * controller, created exclusively), the session record (that controller, replaced atomically),
 * and the two stop requests (`orch stop`). A heartbeat can therefore never overwrite a stop.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname } from 'node:path';

import { ValidationError } from '../core/errors.ts';
import { runnerPaths, type RuntimePaths } from '../core/paths.ts';
import { freshRecord } from './recover.ts';
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
 * `needs-human`: its job waits for a person. `blocked`: started, and cannot go on without one
 * (cancelled, unverified merge, second conflict, a budget spent). `refused`: nothing was started.
 * `claimed`: another process created the ticket's job first. `stopped`: `orch stop` interrupted it.
 */
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];

export interface TicketResult {
  ticketId: number;
  title: string;
  repo: string;
  /** The job that was run or merged last; null when none was created. */
  jobId: string | null;
  outcome: TicketOutcome;
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
  /** The ticket and job in flight. */
  ticketId: number | null;
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
}

function readLock(file: string): { text: string; rec: LockRecord | null } | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const rec = JSON.parse(text) as Partial<LockRecord>;
    if (typeof rec.pid === 'number' && typeof rec.startedAt === 'string') {
      return { text, rec: { pid: rec.pid, startedAt: rec.startedAt } };
    }
  } catch {
    /* partly written */
  }
  return { text, rec: null };
}

/**
 * The PID of the live controller, or null. A lock whose process is gone, that predates the last
 * boot, or whose session has not beaten for HEARTBEAT_STALE_SECONDS (a reused PID) is stale.
 */
export function controllerPid(paths: RuntimePaths): number | null {
  const lock = readLock(runnerPaths(paths).lock)?.rec;
  if (!lock || !alive(lock.pid)) return null;
  const session = readSession(paths);
  const beatAt = session?.pid === lock.pid ? session.beatAt : undefined;
  const nowMs = Date.now();
  return freshRecord({ ...lock, beatAt }, nowMs, bootMs(nowMs)) ? lock.pid : null;
}

/**
 * Become the one controller, or throw while a live one exists. The lock is created exclusively,
 * so of two simultaneous starts one fails here. Returns the release function.
 */
export function acquireRunnerLock(paths: RuntimePaths): () => void {
  const file = runnerPaths(paths).lock;
  mkdirSync(dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const release = () => {
    if (readLock(file)?.text === mine) rmSync(file, { force: true });
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(file, mine, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = controllerPid(paths);
      if (pid !== null) {
        throw new ValidationError(
          `A factory controller is already running (PID ${String(pid)}). ` +
            'See orch status; stop it with orch stop next or orch stop.',
        );
      }
      // A dead controller's lock: remove it only if it is still the one we judged.
      const found = readLock(file);
      if (found && controllerPid(paths) === null && readLock(file)?.text === found.text) {
        rmSync(file, { force: true });
      }
      continue;
    }
    // ponytail: two starters that both judged one dead lock stale can each create a lock, the
    // second after removing the first's. Looking again after a pause leaves exactly one of them
    // holding it; a lock in a directory handle would need native code.
    sleep(100);
    if (readLock(file)?.text === mine) return release;
  }
  throw new ValidationError('Another factory controller is starting; see orch status.');
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
 * Whether the Claude process a dead controller left behind may still be running. Only the PID
 * and the boot time are known, so a reused PID reads as alive: the caller refuses rather than
 * start a second agent on the job, and `orch resume --force` is the person's answer.
 */
export function childMayBeAlive(session: RunnerSession, nowMs = Date.now()): boolean {
  const child = session.child;
  if (!child || !alive(child.pid)) return false;
  const started = Date.parse(child.startedAt);
  return Number.isNaN(started) || started >= bootMs(nowMs) - 60_000;
}
