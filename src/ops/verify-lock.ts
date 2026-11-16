/**
 * One `orch verify` runs checks at a time per runtime home. The CLI is one-shot, so the lock is a
 * file created exclusively (`wx`) holding the holder's PID; a waiter polls with a synchronous
 * sleep inside its own command, and takes over a lock whose holder is no longer running.
 */
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LockHolder {
  pid: number;
  startedAt: string;
}

export interface LockOptions {
  /** Called once, when the lock is found held by a live process. */
  onWait?: ((holder: LockHolder | undefined) => void) | undefined;
  /** Called on every poll while waiting. */
  onPoll?: (() => void) | undefined;
  pollMs?: number | undefined;
}

/** An unreadable lock this old was left by a holder that died while writing it. */
const UNPARSEABLE_GRACE_MS = 10_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
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
      return { text, holder: { pid: h.pid, startedAt: String(h.startedAt) } };
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
 * removes the file while it is still ours.
 */
export function acquireVerifyLock(file: string, opts: LockOptions = {}): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  let notified = false;
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
      opts.onWait?.(found.holder);
    }
    opts.onPoll?.();
    sleep(opts.pollMs ?? 1000);
  }
}
