/**
 * One `orch verify` runs checks at a time per runtime home. The CLI is one-shot, so the lock is a
 * file created exclusively (`wx`) holding the holder's PID and job; a waiter polls with a
 * synchronous sleep inside its own command, and takes over a lock whose holder is no longer
 * running. While it waits, a waiter keeps a queue entry (`<queueDir>/<job>.<pid>.json`) so other
 * processes can show it as queued.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface LockHolder {
  pid: number;
  startedAt: string;
  /** The job verifying; null in a lock written before the job was recorded. */
  jobId: string | null;
}

/** A waiting or running verification, read from the lock file and the queue entries. */
export interface VerifyQueueState {
  state: 'running' | 'queued';
  /** When the run took the lock (running) or began waiting (queued). */
  since: string;
  /** The job holding the lock, when known (this job when running). */
  holderJobId: string | null;
  /** Live waiters that began waiting earlier; a hint, not a promise (any waiter may go next). */
  ahead: number;
}

export interface LockOptions {
  /** Recorded in the lock, and in the queue entry while waiting. */
  jobId?: string | undefined;
  /** Where a waiter records its queue entry; none is written without it. */
  queueDir?: string | undefined;
  /** Called once, when the lock is found held by a live process. */
  onWait?: ((holder: LockHolder | undefined) => void) | undefined;
  /** Called on every poll while waiting. */
  onPoll?: (() => void) | undefined;
  pollMs?: number | undefined;
}

/** An unreadable lock this old was left by a holder that died while writing it. */
const UNPARSEABLE_GRACE_MS = 10_000;

/** Block this thread for `ms` milliseconds (the CLI is one-shot; nothing else needs the loop). */
export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether a process with this PID is running (EPERM: it exists under another user). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

function read(file: string): { text: string; holder: LockHolder | undefined } | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined; // released between our create attempt and this read
  }
  try {
    const h = JSON.parse(text) as Partial<LockHolder>;
    if (typeof h.pid === 'number' && Number.isInteger(h.pid) && h.pid > 0) {
      const jobId = typeof h.jobId === 'string' ? h.jobId : null;
      return { text, holder: { pid: h.pid, startedAt: String(h.startedAt), jobId } };
    }
  } catch {
    /* partly written or corrupt */
  }
  return { text, holder: undefined };
}

function stale(file: string, holder: LockHolder | undefined): boolean {
  if (holder) return !alive(holder.pid);
  try {
    return Date.now() - statSync(file).mtimeMs > UNPARSEABLE_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Block until this process holds the lock at `file`; returns the release function. Release only
 * removes the file while it is still ours. The queue entry, if one was written, is removed once
 * the lock is taken and on every other exit.
 */
export function acquireVerifyLock(file: string, opts: LockOptions = {}): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const mine = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    jobId: opts.jobId ?? null,
  });
  const entry =
    opts.queueDir && opts.jobId
      ? join(opts.queueDir, `${opts.jobId}.${String(process.pid)}.json`)
      : undefined;
  let notified = false;
  try {
    for (;;) {
      try {
        writeFileSync(file, mine, { flag: 'wx' });
        return () => {
          if (read(file)?.text === mine) unlinkSync(file);
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const found = read(file);
      if (found === undefined) continue;
      if (stale(file, found.holder)) {
        // ponytail: re-read then unlink leaves a tiny window in which two waiters both judge one
        // dead holder stale and the second removes the first's fresh lock; the cost is two runs at
        // once, never wrong evidence. A reused PID keeps a dead holder looking alive: delete the file.
        if (read(file)?.text === found.text) {
          try {
            unlinkSync(file);
          } catch {
            /* another waiter removed it */
          }
        }
        continue;
      }
      if (!notified) {
        notified = true;
        if (entry) {
          mkdirSync(dirname(entry), { recursive: true });
          const since = new Date().toISOString();
          writeFileSync(entry, JSON.stringify({ pid: process.pid, jobId: opts.jobId, since }));
        }
        opts.onWait?.(found.holder);
      }
      opts.onPoll?.();
      sleep(opts.pollMs ?? 1000);
    }
  } finally {
    if (entry) rmSync(entry, { force: true });
  }
}

/** Live queue entries (a dead waiter's entry is ignored). */
function liveEntries(queueDir: string): { pid: number; jobId: string; since: string }[] {
  let names: string[];
  try {
    names = readdirSync(queueDir);
  } catch {
    return [];
  }
  const out: { pid: number; jobId: string; since: string }[] = [];
  for (const name of names) {
    try {
      const e = JSON.parse(readFileSync(join(queueDir, name), 'utf8')) as Record<string, unknown>;
      const { pid, jobId, since } = e;
      if (typeof pid === 'number' && typeof jobId === 'string' && typeof since === 'string') {
        if (alive(pid)) out.push({ pid, jobId, since });
      }
    } catch {
      /* removed meanwhile, or partly written */
    }
  }
  return out;
}

/** The live process holding the lock at `file`, or undefined. Read-only. */
export function verifyLockHolder(file: string): LockHolder | undefined {
  const holder = read(file)?.holder;
  return holder && alive(holder.pid) ? holder : undefined;
}

/** Whether `jobId` holds the live lock (running) or has a live queue entry (queued). Read-only. */
export function verifyQueueState(
  file: string,
  queueDir: string,
  jobId: string,
): VerifyQueueState | null {
  const found = read(file);
  const holder = found?.holder && alive(found.holder.pid) ? found.holder : undefined;
  if (holder?.jobId === jobId) {
    return { state: 'running', since: holder.startedAt, holderJobId: jobId, ahead: 0 };
  }
  const entries = liveEntries(queueDir);
  const mine = entries
    .filter((e) => e.jobId === jobId)
    .sort((a, b) => a.since.localeCompare(b.since))[0];
  if (!mine) return null;
  return {
    state: 'queued',
    since: mine.since,
    holderJobId: holder?.jobId ?? null,
    ahead: entries.filter((e) => e.since < mine.since).length,
  };
}
