/**
 * Sessions per repository (ticket 0163): `orch do` in its ticket's slot, a repository queue beside
 * another repository's controller, the legacy root record, and what stop, resume, and status do
 * with several controllers. Uses tests/run-fixture.ts; a lock held by this process stands for
 * another terminal's live controller.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { UsageError, ValidationError } from '../src/core/errors.ts';
import { runnerScope } from '../src/ops/repo.ts';
import { resumeSession, runnerStatus, stopSession } from '../src/ops/run.ts';
import {
  acquireRunnerLock,
  readSession,
  type RunnerLock,
  type RunnerSession,
  runnerSlots,
  slotPid,
  stopRequests,
  writeSession,
} from '../src/ops/runner-state.ts';
import { addTicket } from '../src/ops/tickets.ts';
import { makeRepo, tempDir } from './helpers.ts';
import {
  beta,
  clone,
  DEAD_PID,
  done,
  eventsOf,
  jobsOf,
  launcher,
  one,
  queue,
  quick,
  status,
  store,
  ticket,
} from './run-fixture.ts';

const ALPHA = 'github.com/acme/alpha';
const BETA = 'github.com/acme/beta';
const record = (over: Partial<RunnerSession> = {}): RunnerSession => {
  const at = new Date().toISOString();
  return {
    pid: DEAD_PID,
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
/** Another terminal's controller for `repo`, running (this PID) or interrupted (a dead one). */
function controller(repo: string, live: boolean, startedAt?: string): RunnerLock {
  const scope = runnerScope(repo);
  const lock = acquireRunnerLock(store.paths, scope.key, scope);
  const at = startedAt ?? new Date().toISOString();
  writeSession(
    store.paths,
    record({ pid: live ? process.pid : DEAD_PID, repo, scope: scope.name, startedAt: at }),
    scope.key,
  );
  if (!live) lock();
  return lock;
}
const key = (repo: string) => runnerScope(repo).key;

describe('orch do lives in its ticket’s slot (AC3)', () => {
  it('is refused while a controller covers the repository, and runs beside another repository’s', async () => {
    const id = ticket('Alpha work');
    const other = controller(beta.clone, true);
    const own = controller(clone, true);
    await expect(one(launcher(done), id)).rejects.toThrow(/already running .*acme\/alpha/);
    expect(jobsOf(id)).toHaveLength(0);
    own();
    writeSession(store.paths, record({ finished: { at: 'x', reason: 'r' } }), key(clone));

    const s = await one(launcher(done), id);

    expect(s).toMatchObject({ completed: 1 });
    expect(status(id)).toBe('done');
    expect(readSession(store.paths)).toBeNull();
    expect(readSession(store.paths, key(clone))).toMatchObject({
      mode: 'ticket',
      repo: null,
      scope: ALPHA,
      ticket: id,
    });
    // Its evidence is on its own job, and the other controller's files were never touched.
    expect(eventsOf(jobsOf(id)[0]?.id ?? '', 'runner.session')).toHaveLength(1);
    expect(other.owned()).toBe(true);
    expect(readSession(store.paths, key(beta.clone))?.results).toEqual([]);
    other();
  });

  it('scopes by the remote identity when the checkout is gone, and refuses a directory name', async () => {
    const remote = makeRepo('git@github.com:acme/gone.git');
    const dir = join(tempDir(), 'localonly');
    mkdirSync(dir);
    const local = makeRepo(undefined, dir);
    const byRemote = addTicket(store, { title: 'Remote', repo: remote }).id;
    const byName = addTicket(store, { title: 'Local', repo: local }).id;
    const slot = runnerScope(remote).key;
    rmSync(remote, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });

    await one(launcher(done), byRemote);
    expect(readSession(store.paths, slot)).toMatchObject({
      scope: 'github.com/acme/gone',
      ticket: byRemote,
    });

    const before = runnerSlots(store.paths).map((s) => s.key);
    const refused = one(launcher(done), byName);
    await expect(refused).rejects.toThrow(ValidationError);
    await expect(refused).rejects.toThrow(
      /belongs to localonly, whose checkout .*localonly is missing/,
    );
    // No lock was taken anywhere.
    expect(runnerSlots(store.paths).map((s) => s.key)).toEqual(before);
    expect(slotPid(store.paths)).toBeNull();
  });
});

describe('a repository queue beside another repository’s controller', () => {
  it('runs its own tickets only and writes runner events only on its own jobs (AC1, AC13)', async () => {
    const mine = ticket('Alpha work');
    const theirs = addTicket(store, { title: 'Beta work', repo: beta.clone }).id;
    const other = controller(beta.clone, true);

    const s = await queue(launcher(done), clone);

    expect(s).toMatchObject({ completed: 1, attempted: 1 });
    expect([status(mine), status(theirs)]).toEqual(['done', 'open']);
    expect(jobsOf(theirs)).toHaveLength(0);
    expect(eventsOf(jobsOf(mine)[0]?.id ?? '', 'runner.session')).toHaveLength(1);
    expect(readSession(store.paths, key(clone))).toMatchObject({ repo: clone, scope: ALPHA });
    expect(other.owned()).toBe(true);
    // The whole queue is still refused while beta's controller lives.
    await expect(queue(launcher(done))).rejects.toThrow(/already running .*acme\/beta/);
    other();
  });
});

describe('default targets and --repo (AC7, AC8, AC11)', () => {
  it('with two live controllers stop needs --repo, and status lists both', () => {
    const a = controller(clone, true, '2026-11-26T10:00:00.000Z');
    const b = controller(beta.clone, true, '2026-11-26T09:00:00.000Z');

    for (const which of ['now', 'next'] as const) {
      let thrown: unknown;
      try {
        stopSession(store, which, 0);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
      expect((thrown as UsageError).message).toContain(ALPHA);
      expect((thrown as UsageError).message).toContain(BETA);
    }
    expect(stopSession(store, 'next', 0, undefined, beta.clone).pid).toBe(process.pid);
    expect(stopRequests(store.paths, key(beta.clone))).toEqual({ next: true, now: false });
    expect(stopRequests(store.paths, key(clone))).toEqual({ next: false, now: false });

    const st = runnerStatus(store);
    expect(st.controllers).toMatchObject([
      { scope: BETA, state: 'running', pid: process.pid, repo: beta.clone, stop: { next: true } },
      { scope: ALPHA, state: 'running', pid: process.pid, repo: clone, stop: { next: false } },
    ]);
    expect(st.last).toBeNull();
    a();
    b();
  });

  it('stops the one live controller, and discards the interrupted one by --repo', () => {
    const live = controller(beta.clone, true, '2026-11-26T10:00:00.000Z');
    controller(clone, false, '2026-11-26T09:00:00.000Z');
    // Live first, whatever the start order.
    expect(runnerStatus(store).controllers.map((c) => [c.scope, c.state])).toEqual([
      [BETA, 'running'],
      [ALPHA, 'interrupted'],
    ]);

    expect(stopSession(store, 'now', 0)).toMatchObject({ requested: 'now', pid: process.pid });
    expect(stopRequests(store.paths, key(beta.clone)).now).toBe(true);
    expect(stopRequests(store.paths, key(clone)).now).toBe(false);

    const discarded = stopSession(store, 'now', 0, undefined, clone);
    expect(discarded).toMatchObject({ pid: null });
    expect(discarded.message).toContain('discarded');
    expect(readSession(store.paths, key(clone))?.finished?.reason).toContain('discarded');
    expect(readSession(store.paths, key(beta.clone))?.finished).toBeNull();
    expect(live.owned()).toBe(true);
    expect(runnerStatus(store)).toMatchObject({
      controllers: [{ scope: BETA }],
      last: { scope: ALPHA, completed: 0, attempted: 0 },
    });
    live();
  });

  it('acts on the one interrupted session, lists several, and names the open ones for a wrong --repo', async () => {
    expect(() => stopSession(store, 'now', 0)).toThrow(/nothing to stop/);
    await expect(resumeSession(store, {}, quick)).rejects.toThrow(/no factory session to resume/);

    controller(clone, false);
    const other = makeRepo('git@github.com:acme/other.git');
    const acts: (() => unknown)[] = [
      () => stopSession(store, 'next', 0, undefined, other),
      () => resumeSession(store, { repo: other }, quick),
    ];
    for (const act of acts) {
      const refused = Promise.resolve().then(act);
      await expect(refused).rejects.toThrow(ValidationError);
      await expect(refused).rejects.toThrow(
        /No factory session is running or interrupted for github\.com\/acme\/other; there is one for: github\.com\/acme\/alpha/,
      );
    }
    await expect(resumeSession(store, { repo: tempDir() }, quick)).rejects.toThrow(
      /not inside a Git repository/,
    );
    expect(stopSession(store, 'next', 0).pid).toBeNull();
    expect(stopRequests(store.paths, key(clone)).next).toBe(true);

    controller(beta.clone, false);
    const several = resumeSession(store, {}, quick);
    await expect(several).rejects.toThrow(UsageError);
    await expect(several).rejects.toThrow(new RegExp(`${ALPHA}, ${BETA}|${BETA}, ${ALPHA}`));
    expect(() => stopSession(store, 'now', 0)).toThrow(UsageError);

    // Named, the one in alpha is resumed under its own lock: `stop next` was kept for it.
    const s = await resumeSession(
      store,
      { repo: clone },
      { launch: launcher(done).launch, ...quick },
    );
    expect(s.reason).toContain('orch stop next');
    expect(readSession(store.paths, key(clone))?.finished).not.toBeNull();
    expect(readSession(store.paths, key(beta.clone))?.finished).toBeNull();
    // One interrupted session is left: resume and stop find it without --repo.
    expect(stopSession(store, 'now', 0).message).toContain('discarded');
    expect(runnerStatus(store).controllers).toEqual([]);
  });
});

describe('a record an older orch left at the data root (AC6)', () => {
  it('is the unscoped slot’s session: it refuses every start, resumes, and is discarded without --repo', async () => {
    const id = ticket('Alpha work');
    writeSession(store.paths, record({ repo: clone }));

    expect(runnerStatus(store).controllers).toMatchObject([
      { scope: clone, state: 'interrupted', mode: 'queue', repo: clone },
    ]);
    for (const start of [() => queue(launcher(done), beta.clone), () => one(launcher(done), id)]) {
      await expect(start()).rejects.toThrow(/was interrupted.*orch resume/s);
    }
    expect(runnerSlots(store.paths).every((s) => s.pid === null)).toBe(true);

    let holder: (number | null)[] = [];
    const l = launcher((job) => {
      holder = [slotPid(store.paths), slotPid(store.paths, key(clone))];
      done(job, { prompt: '', cwd: '', env: {}, sessionId: '' } as never);
    });
    const s = await resumeSession(store, {}, { launch: l.launch, ...quick });
    expect(s).toMatchObject({ completed: 1 });
    expect(holder).toEqual([process.pid, null]); // under the unscoped lock
    expect(readSession(store.paths)?.finished).not.toBeNull();

    writeSession(store.paths, record({ repo: null, mode: 'ticket', ticket: id }));
    expect(stopSession(store, 'now', 0).message).toContain('discarded');
    expect(readSession(store.paths)?.finished?.reason).toContain('discarded');
  });
});
