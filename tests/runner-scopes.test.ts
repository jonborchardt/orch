/**
 * One controller slot per repository (ticket 0163, decision
 * 2026-11-25-one-controller-per-repository): which starters are admitted together, which are
 * refused, and that each slot's files and liveness are its own. Locks are held by this process,
 * which is what a live controller looks like to every reader.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { runnerPaths, type RuntimePaths } from '../src/core/paths.ts';
import { runnerScope, scopesOverlap, ticketRunnerScope } from '../src/ops/repo.ts';
import {
  acquireRunnerLock,
  controllerContinues,
  controllerPid,
  controllerTakesCi,
  readSession,
  requestStop,
  type RunnerLock,
  type RunnerSession,
  runnerSlots,
  slotPid,
  stopRequests,
  writeSession,
} from '../src/ops/runner-state.ts';
import { cleanupTempDirs, gitIn, homePaths, makeRepo, tempDir } from './helpers.ts';

const DEAD = 2 ** 31 - 1;
const ALPHA = 'git@github.com:acme/alpha.git';
const alpha = makeRepo(ALPHA);
const beta = makeRepo('git@github.com:acme/beta.git');
afterAll(cleanupTempDirs);

const home = (): RuntimePaths => homePaths(tempDir('orch-scopes-'));
/** What `orch start --repo <repo>` does to the lock. */
const take = (paths: RuntimePaths, repo: string): RunnerLock => {
  const scope = runnerScope(repo);
  return acquireRunnerLock(paths, scope.key, scope);
};
/** The same, with the session record a controller writes as soon as it holds the lock. */
const run = (paths: RuntimePaths, repo: string): RunnerLock => {
  const lock = take(paths, repo);
  const scope = runnerScope(repo);
  writeSession(paths, session({ repo, scope: scope.name }), scope.key);
  return lock;
};
const session = (over: Partial<RunnerSession> = {}): RunnerSession => {
  const at = new Date().toISOString();
  return {
    pid: process.pid,
    startedAt: at,
    beatAt: at,
    mode: 'queue',
    repo: null,
    ticket: null,
    ticketId: null,
    jobId: null,
    child: null,
    results: [],
    skipped: [],
    finished: null,
    ...over,
  };
};
/** Every file under the slot's directory with its bytes. */
const filesOf = (paths: RuntimePaths, key: string): Record<string, string> => {
  const dir = join(runnerPaths(paths).root, key);
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), 'utf8')]),
  );
};

describe('runnerScope', () => {
  it('names a repository by its remote, else by its common directory, and refuses a non-repository', () => {
    const a = runnerScope(alpha);
    expect(a.name).toBe('github.com/acme/alpha');
    expect(a.key).toMatch(/^[0-9a-f]{16}$/);
    expect(runnerScope(makeRepo(ALPHA))).toMatchObject({ key: a.key, name: a.name });
    const local = makeRepo();
    expect(runnerScope(local).name).toBe(runnerScope(local).commonDir);
    expect(() => runnerScope(tempDir())).toThrow(/not inside a Git repository/);
    expect(() => runnerScope(join(tempDir(), 'missing'))).toThrow(/not inside a Git repository/);
  });

  it('scopes a ticket by its checkout, else by its remote identity, else refuses', () => {
    const gone = join(tempDir(), 'gone');
    expect(ticketRunnerScope({ key: '0001', repo: 'x', repoPath: alpha })).toEqual(
      runnerScope(alpha),
    );
    expect(
      ticketRunnerScope({ key: '0001', repo: 'github.com/acme/alpha', repoPath: gone }),
    ).toEqual({ ...runnerScope(alpha), commonDir: null });
    expect(() => ticketRunnerScope({ key: '0007', repo: 'alpha', repoPath: gone })).toThrow(
      /Ticket 0007 belongs to alpha, whose checkout .*gone is missing/,
    );
  });

  it('overlaps on the unscoped slot, an equal key, or an equal common directory', () => {
    const a = { key: 'a', commonDir: 'X' };
    expect(scopesOverlap(null, a)).toBe(true);
    expect(scopesOverlap(a, null)).toBe(true);
    expect(scopesOverlap(a, { key: 'a', commonDir: null })).toBe(true);
    expect(scopesOverlap(a, { key: 'b', commonDir: 'X' })).toBe(true);
    expect(scopesOverlap(a, { key: 'b', commonDir: 'Y' })).toBe(false);
    expect(scopesOverlap({ key: 'a', commonDir: null }, { key: 'b', commonDir: null })).toBe(false);
  });
});

describe('admission (AC1, AC2)', () => {
  it('lets two repositories hold their locks at once and refuses a second one for the same', () => {
    const paths = home();
    const a = run(paths, alpha);
    const b = run(paths, beta);
    expect([a.owned(), b.owned()]).toEqual([true, true]);
    expect(runnerSlots(paths).map((s) => s.pid)).toEqual([null, process.pid, process.pid]);

    // The same path, another clone of the same remote, and a linked worktree.
    expect(() => take(paths, alpha)).toThrow(/already running .*github\.com\/acme\/alpha/);
    expect(() => take(paths, makeRepo(ALPHA))).toThrow(/already running/);
    const wt = join(tempDir(), 'wt');
    gitIn(alpha, 'worktree', 'add', '-q', '-b', 'wt', wt);
    expect(() => take(paths, wt)).toThrow(/already running/);
    expect([a.owned(), b.owned()]).toEqual([true, true]);
    a();
    b();
  });

  it('keeps one checkout one scope when its origin is added under a live or interrupted session', () => {
    for (const interrupted of [false, true]) {
      const paths = home();
      const repo = makeRepo();
      const before = runnerScope(repo);
      const lock = take(paths, repo);
      if (interrupted) {
        writeSession(paths, session({ pid: DEAD, repo, scope: before.name }), before.key);
        lock();
      }
      gitIn(repo, 'remote', 'add', 'origin', 'git@github.com:acme/gamma.git');
      const after = runnerScope(repo);
      expect(after.key).not.toBe(before.key);
      expect(after.commonDir).toBe(before.commonDir);

      expect(() => take(paths, repo)).toThrow(interrupted ? /was interrupted/ : /already running/);
      // The refused starter gave its generation back.
      expect(slotPid(paths, after.key)).toBeNull();
      expect(slotPid(paths, before.key)).toBe(interrupted ? null : process.pid);
    }
  });

  it('overlaps a slot without a common directory by key only', () => {
    const paths = home();
    const gone = ticketRunnerScope({
      key: '0001',
      repo: 'github.com/acme/alpha',
      repoPath: join(tempDir(), 'gone'),
    });
    const lock = acquireRunnerLock(paths, gone.key, gone);
    expect(() => take(paths, alpha)).toThrow(/already running/); // the same key
    const b = take(paths, beta);
    expect([lock.owned(), b.owned()]).toEqual([true, true]);
  });

  it('refuses an unscoped start beside a scoped controller, and every scoped start beside an unscoped one', () => {
    const paths = home();
    const key = runnerScope(alpha).key;
    const a = run(paths, alpha);
    expect(() => acquireRunnerLock(paths)).toThrow(/already running .*github\.com\/acme\/alpha/);
    expect(slotPid(paths)).toBeNull();
    expect(controllerPid(paths)).toBe(process.pid);
    a();
    expect(controllerPid(paths)).toBeNull();
    writeSession(paths, session({ repo: alpha, finished: { at: 'x', reason: 'r' } }), key);

    const all = acquireRunnerLock(paths);
    expect(() => take(paths, alpha)).toThrow(/already running .*every repository/);
    expect(() => take(paths, beta)).toThrow(/already running/);
    expect([slotPid(paths, key), slotPid(paths, runnerScope(beta).key)]).toEqual([null, null]);
    expect(all.owned()).toBe(true);
    all();
  });

  it('refuses across an interrupted session, both ways', () => {
    const scoped = home();
    const scope = runnerScope(alpha);
    writeSession(scoped, session({ pid: DEAD, repo: alpha, scope: scope.name }), scope.key);
    expect(() => acquireRunnerLock(scoped)).toThrow(
      /session for github\.com\/acme\/alpha .* was interrupted.*orch resume/,
    );
    expect(slotPid(scoped)).toBeNull();
    take(scoped, beta)(); // another repository is not held up

    const unscoped = home();
    writeSession(unscoped, session({ pid: DEAD, ticketId: 7 }));
    expect(() => take(unscoped, alpha)).toThrow(
      /session for every repository .* was interrupted at ticket 0007/,
    );
    expect(slotPid(unscoped, scope.key)).toBeNull();
  });
});

describe('per slot (AC4, AC5)', () => {
  it('takes over a dead holder in its own slot, which never blocks another slot', () => {
    const paths = home();
    const key = runnerScope(alpha).key;
    const dir = runnerPaths(paths, key).lock;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '1'),
      JSON.stringify({ pid: DEAD, startedAt: new Date().toISOString() }),
    );
    const b = take(paths, beta);
    expect(b.owned()).toBe(true);
    const a = take(paths, alpha);
    expect(a.owned()).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['1', '2']);
  });

  it('keeps a heartbeat and stop requests in the slot they were made for', () => {
    const paths = home();
    const [ka, kb] = [runnerScope(alpha).key, runnerScope(beta).key];
    take(paths, alpha);
    take(paths, beta);
    writeSession(paths, session({ repo: beta }), kb);
    const before = filesOf(paths, kb);

    writeSession(paths, session({ repo: alpha }), ka);
    requestStop(paths, 'next', ka);
    requestStop(paths, 'now', ka);
    expect(stopRequests(paths, ka)).toEqual({ next: true, now: true });
    expect(stopRequests(paths, kb)).toEqual({ next: false, now: false });
    expect(stopRequests(paths)).toEqual({ next: false, now: false });
    expect(readSession(paths)).toBeNull();
    expect(filesOf(paths, kb)).toEqual(before);

    // Liveness is the slot's own heartbeat: a stale one in alpha says nothing about beta.
    const old = new Date(Date.now() - 6 * 3600_000).toISOString();
    writeSession(paths, session({ repo: alpha, beatAt: old }), ka);
    expect([slotPid(paths, ka), slotPid(paths, kb)]).toEqual([null, process.pid]);
    expect(filesOf(paths, kb)).toEqual(before);
  });
});

describe('the other readers (AC10)', () => {
  it('controllerTakesCi is true for a live scoped controller on the job, in its own slot only', () => {
    const paths = home();
    const [ka, kb] = [runnerScope(alpha).key, runnerScope(beta).key];
    const at = new Date().toISOString();
    const onJob = session({ jobId: 'job-0000000a', child: { pid: process.pid, startedAt: at } });
    const job = { id: 'job-0000000a' };

    writeSession(paths, onJob, ka);
    expect(controllerTakesCi(paths, job)).toBe(false); // no live holder
    const b = take(paths, beta);
    expect(controllerTakesCi(paths, job)).toBe(false); // the live holder is another slot's
    const a = take(paths, alpha);
    expect(controllerTakesCi(paths, job)).toBe(true);
    expect(controllerTakesCi(paths, { id: 'job-0000000b' })).toBe(false);
    writeSession(paths, { ...onJob, child: null }, ka);
    expect(controllerTakesCi(paths, job)).toBe(false);
    a();
    b();
    expect(readSession(paths, kb)).toBeNull();
  });

  it('controllerContinues is true while a live slot’s queue passed the ticket over for a person', () => {
    const paths = home();
    const scope = runnerScope(alpha);
    const waits = session({
      repo: alpha,
      scope: scope.name,
      results: [
        {
          ticketId: 7,
          title: 't',
          repo: scope.name,
          jobId: 'job-0000000a',
          outcome: 'needs-human',
          code: 'needs-human',
          reason: 'r',
          relands: 0,
          next: null,
        },
      ],
    });
    const job = { ticketId: 7, repo: scope.name, repoPath: alpha };
    writeSession(paths, waits, scope.key);
    expect(controllerContinues(paths, job)).toBe(false); // nobody runs it
    const a = take(paths, alpha);
    expect(controllerContinues(paths, job)).toBe(true);
    expect(controllerContinues(paths, { ...job, ticketId: 8 })).toBe(false);
    expect(
      controllerContinues(paths, { ticketId: 7, repo: 'github.com/acme/beta', repoPath: beta }),
    ).toBe(false);
    writeSession(paths, { ...waits, mode: 'ticket' }, scope.key);
    expect(controllerContinues(paths, job)).toBe(false);
    a();
  });

  it('controllerPid finds a live controller of any slot', () => {
    const paths = home();
    expect(controllerPid(paths)).toBeNull();
    const b = take(paths, beta);
    expect(controllerPid(paths)).toBe(process.pid);
    b();
    expect(controllerPid(paths)).toBeNull();
    rmSync(paths.data, { recursive: true, force: true });
    expect(runnerSlots(paths).map((s) => s.key)).toEqual([undefined]);
  });
});
