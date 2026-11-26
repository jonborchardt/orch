/**
 * What the foreground factory controller (`orch start`) keeps outside the database: who holds the
 * controller, what the session was asked to do, and whether a stop was requested. Job stage,
 * ticket status, CI, and merge evidence stay where they are; nothing here repeats them.
 *
 * There is one controller per repository at most (decision
 * 2026-11-25-one-controller-per-repository), each in its own slot (`runnerSlots`). A slot's files
 * are kept under the data directory (`runnerPaths`), each with one writer: the lock (generations
 * taken by exclusive creation, see `acquireRunnerLock`), the session record (that controller,
 * replaced atomically), and the two stop requests (`orch stop`). A heartbeat can therefore never
 * overwrite a stop.
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
import { ticketKey } from '../core/tickets.ts';
import { freshRecord } from './recover.ts';
import { inRepositoryAt, type RunnerScope, scopesOverlap } from './repo.ts';
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
  /**
   * The repository the session's slot belongs to, as shown (`RunnerScope.name`). Absent in the
   * unscoped slot and in records written before slots.
   */
  scope?: string | undefined;
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

/** The session record of one slot (`key`; none is the unscoped slot). */
export function readSession(paths: RuntimePaths, key?: string): RunnerSession | null {
  try {
    const s = JSON.parse(readFileSync(runnerPaths(paths, key).state, 'utf8')) as RunnerSession;
    return typeof s.pid === 'number' && typeof s.startedAt === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** Replace a file in one step: a reader sees the old content or the new. */
function replaceFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, text);
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

/** Replace the slot's session record in one step. */
export function writeSession(paths: RuntimePaths, session: RunnerSession, key?: string): void {
  replaceFile(runnerPaths(paths, key).state, JSON.stringify(session, null, 2) + '\n');
}

/** The common directory a repository slot's starter recorded (`scope.json`); null when none. */
function recordedCommonDir(paths: RuntimePaths, key: string): string | null {
  try {
    const rec = JSON.parse(readFileSync(runnerPaths(paths, key).scope, 'utf8')) as {
      commonDir?: unknown;
    };
    return typeof rec.commonDir === 'string' ? rec.commonDir : null;
  } catch {
    return null;
  }
}

interface LockRecord {
  pid: number;
  startedAt: string;
  /** The holder gave the lock up (it may still be running, as in tests). */
  released?: boolean;
}

const lockFile = (paths: RuntimePaths, key: string | undefined, generation: number) =>
  join(runnerPaths(paths, key).lock, String(generation));

/** The highest lock generation taken so far in the slot; 0 when there is none. */
function topGeneration(paths: RuntimePaths, key: string | undefined): number {
  let names: string[];
  try {
    names = readdirSync(runnerPaths(paths, key).lock);
  } catch {
    return 0;
  }
  return Math.max(0, ...names.map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

/** The live controller holding `generation`, or null when its holder is gone or gave it up. */
function holderOf(
  paths: RuntimePaths,
  key: string | undefined,
  generation: number,
): LockRecord | null {
  let rec: Partial<LockRecord>;
  try {
    rec = JSON.parse(readFileSync(lockFile(paths, key, generation), 'utf8')) as Partial<LockRecord>;
  } catch {
    return null; // generations appear whole (linked into place), so this one is damaged
  }
  const { pid, startedAt } = rec;
  if (typeof pid !== 'number' || typeof startedAt !== 'string' || rec.released === true)
    return null;
  if (!alive(pid)) return null;
  // The heartbeat is the slot's own: another slot's session says nothing about this holder.
  const session = readSession(paths, key);
  const beatAt = session?.pid === pid ? session.beatAt : undefined;
  const nowMs = Date.now();
  return freshRecord({ pid, startedAt, beatAt }, nowMs, bootMs(nowMs)) ? { pid, startedAt } : null;
}

/**
 * The PID of the slot's live controller, or null. The holder of the highest generation is the
 * only candidate; it is stale when its process is gone, it predates the last boot, it released
 * the lock, or its session has not beaten for HEARTBEAT_STALE_SECONDS (a reused PID).
 */
export function slotPid(paths: RuntimePaths, key?: string): number | null {
  const top = topGeneration(paths, key);
  return top === 0 ? null : (holderOf(paths, key, top)?.pid ?? null);
}

/**
 * One controller slot (decision 2026-11-25-one-controller-per-repository): the unscoped one
 * ("every repository", no key, the files at the data root, whatever an older orch left there) or
 * a repository's, under `<data>/runners/<key>/`.
 */
export interface RunnerSlot {
  key: string | undefined;
  /** What the slot's starter recorded; null for the unscoped slot and a remote-only scope. */
  commonDir: string | null;
  session: RunnerSession | null;
  /** The slot's live controller. */
  pid: number | null;
}

/** Every slot there is: the unscoped one first, then each repository's that was ever used. */
export function runnerSlots(paths: RuntimePaths): RunnerSlot[] {
  let keys: string[] = [];
  try {
    keys = readdirSync(runnerPaths(paths).root).sort();
  } catch {
    /* no repository slot yet */
  }
  return [undefined, ...keys].map((key) => ({
    key,
    commonDir: key === undefined ? null : recordedCommonDir(paths, key),
    session: readSession(paths, key),
    pid: slotPid(paths, key),
  }));
}

/** A slot somebody has to deal with: a live controller, or a session left unfinished. */
export const slotOpen = (s: RunnerSlot): boolean =>
  s.pid !== null || (s.session !== null && s.session.finished === null);

/** How a slot is shown; a legacy record (no `scope`) reads as its queue filter. */
export const slotName = (s: Pick<RunnerSlot, 'key' | 'session'>): string =>
  s.session?.scope ?? s.session?.repo ?? s.key ?? 'every repository';

/** The PID of a live controller of any slot, or null. */
export function controllerPid(paths: RuntimePaths): number | null {
  return runnerSlots(paths).find((s) => s.pid !== null)?.pid ?? null;
}

const runningRefusal = (pid: number, name: string): string =>
  `A factory controller is already running (PID ${String(pid)}) for ${name}. ` +
  'See orch status; stop it with orch stop next or orch stop.';

/** Why nothing overlapping starts while the slot's `session` is left unfinished. */
export function interruptedRefusal(key: string | undefined, session: RunnerSession): string {
  return (
    `A factory session for ${slotName({ key, session })} started ${session.startedAt} was interrupted` +
    (session.ticketId === null ? '' : ` at ticket ${ticketKey(session.ticketId)}`) +
    '. Continue it with orch resume, or discard it with orch stop; then start again.'
  );
}

/** The release function of a held lock; `owned()` says whether its generation is still the top. */
export type RunnerLock = (() => void) & { owned(): boolean };

/**
 * Become the one controller of a slot, or throw while a live one exists there or in a slot that
 * overlaps it (`scopesOverlap`), or while an overlapping slot's session is left unfinished.
 * Returns the release function, with `owned()`: false once a higher generation exists, which is
 * for good (numbers only grow). `start` is given by a new session (`orch start`, `orch do`):
 * what to record as the slot's scope. Resume and discard leave the record as it is.
 *
 * The lock is a sequence of generations, `runner-lock/<n>` in the slot. A starter that finds
 * generation n stale takes over by creating n + 1, and creating a file that already exists
 * fails: of any number of starters judging the same stale lock, exactly one gets the next
 * generation, and the others find a live holder when they look again. Nothing is ever removed
 * or overwritten by a competitor, so there is no moment at which a fresh lock can be taken away.
 *
 * Across slots there is no shared file to create. A starter holds its own generation, and has
 * recorded its scope, before it looks at the others, so of two overlapping starters at least one
 * sees the other and gives its generation back. Both may: neither then runs.
 *
 * ponytail: one small file per controller session is kept for good. Removing old generations
 * would free their numbers for a starter still acting on an earlier look; prune only with a
 * rule that cannot do that.
 */
export function acquireRunnerLock(
  paths: RuntimePaths,
  key?: string,
  start?: Pick<RunnerScope, 'name' | 'commonDir'>,
): RunnerLock {
  const dir = runnerPaths(paths, key).lock;
  mkdirSync(dir, { recursive: true });
  const mine: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
  // Written in full first and linked into place, so a generation is never seen half written.
  const tmp = join(dir, `tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify(mine));
  try {
    for (;;) {
      const top = topGeneration(paths, key);
      const holder = top === 0 ? null : holderOf(paths, key, top);
      if (holder !== null) {
        throw new ValidationError(
          runningRefusal(holder.pid, slotName({ key, session: readSession(paths, key) })),
        );
      }
      const generation = top + 1;
      const file = lockFile(paths, key, generation);
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
      try {
        admit(paths, key, start);
      } catch (err) {
        release();
        throw err;
      }
      return Object.assign(release, { owned: () => topGeneration(paths, key) === generation });
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The second half of `acquireRunnerLock`, as the holder of the slot's top generation. */
function admit(
  paths: RuntimePaths,
  key: string | undefined,
  start: Pick<RunnerScope, 'name' | 'commonDir'> | undefined,
): void {
  // An unfinished session keeps the scope it was started with; `startSession` refuses over it.
  const unfinished = readSession(paths, key)?.finished === null;
  if (key !== undefined && start !== undefined && !unfinished) {
    const { name, commonDir } = start;
    replaceFile(runnerPaths(paths, key).scope, JSON.stringify({ name, commonDir }) + '\n');
  }
  const mine = key === undefined ? null : { key, commonDir: recordedCommonDir(paths, key) };
  for (const other of runnerSlots(paths)) {
    if (other.key === key) continue;
    const theirs = other.key === undefined ? null : { key: other.key, commonDir: other.commonDir };
    if (!scopesOverlap(mine, theirs)) continue;
    if (other.pid !== null) throw new ValidationError(runningRefusal(other.pid, slotName(other)));
    if (other.session?.finished === null) {
      throw new ValidationError(interruptedRefusal(other.key, other.session));
    }
  }
}

export interface StopRequests {
  /** Finish the current ticket, then exit (`orch stop next`). */
  next: boolean;
  /** End the current execution now, leaving the job resumable (`orch stop`). */
  now: boolean;
}

/** The stop requests left for one slot's controller. */
export function stopRequests(paths: RuntimePaths, key?: string): StopRequests {
  const files = runnerPaths(paths, key);
  return { next: existsSync(files.stopNext), now: existsSync(files.stopNow) };
}

export function requestStop(paths: RuntimePaths, which: keyof StopRequests, key?: string): void {
  const files = runnerPaths(paths, key);
  const file = which === 'next' ? files.stopNext : files.stopNow;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, new Date().toISOString() + '\n');
}

export function clearStop(paths: RuntimePaths, which: keyof StopRequests, key?: string): void {
  const files = runnerPaths(paths, key);
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
 * Whether a running queue controller takes the job's ticket again once a person acts on it: a
 * live controller of any slot, in queue mode, whose repository filter covers the job, whose
 * session passed the ticket over as `awaitsPerson`. Read-only; the dashboard's after-action line
 * asks this.
 */
export function controllerContinues(
  paths: RuntimePaths,
  job: { ticketId: number | null; repo: string; repoPath: string },
): boolean {
  if (job.ticketId === null) return false;
  return runnerSlots(paths).some(({ pid, session: s }) => {
    if (pid === null || s?.finished !== null || s.mode === 'ticket') return false;
    if (!s.results.some((r) => r.ticketId === job.ticketId && awaitsPerson(r))) return false;
    try {
      return s.repo === null || inRepositoryAt(s.repo)(job);
    } catch {
      return false; // the filtered checkout is gone: nothing can say it covers the job
    }
  });
}

/**
 * Whether a live controller takes the job's `ci` stage: some slot's unfinished session is on this
 * job, has started a child for it, and that slot's live lock holder is the session's controller.
 * Read-only; `planJob` asks this so the child releases at the first pending observation and the
 * controller's `pollCi` waits for CI without spending a Claude turn.
 */
export function controllerTakesCi(paths: RuntimePaths, job: { id: string }): boolean {
  return runnerSlots(paths).some(
    ({ pid, session: s }) =>
      s?.finished === null && s.jobId === job.id && s.child !== null && pid === s.pid,
  );
}
