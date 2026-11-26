/**
 * `orch start | stop | status | resume` with `--repo` and several controllers (ticket 0163), at
 * the command line: exit codes and what is printed. A lock held by this process is a live
 * controller to the spawned CLI.
 */
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';

import { runnerScope } from '../src/ops/repo.ts';
import type { RunnerStatus } from '../src/ops/run.ts';
import {
  acquireRunnerLock,
  readSession,
  type RunnerSession,
  stopRequests,
  writeSession,
} from '../src/ops/runner-state.ts';
import { cleanupTempDirs, homePaths, json, makeRepo, orch, tempDir } from './helpers.ts';

const ALPHA = 'github.com/acme/alpha';
const BETA = 'github.com/acme/beta';
const alpha = makeRepo('git@github.com:acme/alpha.git');
const beta = makeRepo('git@github.com:acme/beta.git');
afterAll(cleanupTempDirs);

const record = (over: Partial<RunnerSession>): RunnerSession => {
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
function live(home: string, repo: string) {
  const scope = runnerScope(repo);
  const lock = acquireRunnerLock(homePaths(home), scope.key, scope);
  writeSession(homePaths(home), record({ repo, scope: scope.name }), scope.key);
  return lock;
}
const cli = (home: string, ...args: string[]) => orch(home, tmpdir(), args);

describe('orch start --repo', () => {
  it('starts a scoped queue, as orch start repo does, and exits 1 outside a repository', () => {
    const home = tempDir();
    const scoped = cli(home, 'start', '--repo', alpha);
    expect(scoped.err).toBe('');
    expect(scoped).toMatchObject({ code: 0 });
    expect(scoped.out).toContain('no ready ticket is left');
    const slot = runnerScope(alpha).key;
    const first = readSession(homePaths(home), slot);
    expect(first).toMatchObject({ mode: 'queue', scope: ALPHA });
    expect(first?.finished).not.toBeNull();
    expect(readSession(homePaths(home))).toBeNull();

    expect(orch(home, alpha, ['start', 'repo']).code).toBe(0);
    expect(readSession(homePaths(home), slot)?.startedAt).not.toBe(first?.startedAt);
    expect(readSession(homePaths(home))).toBeNull();

    const outside = cli(home, 'start', '--repo', tempDir());
    expect(outside.code).toBe(1);
    expect(outside.err).toContain('is not inside a Git repository');
    expect(cli(home, 'start', 'repo', '--repo', alpha).code).toBe(2);
    expect(cli(home, 'do', '1', '--repo', alpha).code).toBe(2);
    expect(cli(home, 'status', '--repo', alpha).code).toBe(2);
  });
});

describe('several controllers', () => {
  it('stop without --repo exits 2 and lists them; --repo names one; status prints a block each', () => {
    const home = tempDir();
    const a = live(home, alpha);
    const b = live(home, beta);
    try {
      for (const args of [['stop'], ['stop', 'next']]) {
        const r = cli(home, ...args);
        expect(r.code).toBe(2);
        expect(r.err).toContain(ALPHA);
        expect(r.err).toContain(BETA);
      }
      expect(cli(home, 'stop', 'next', '--repo', beta).code).toBe(0);
      expect(stopRequests(homePaths(home), runnerScope(beta).key).next).toBe(true);
      expect(stopRequests(homePaths(home), runnerScope(alpha).key).next).toBe(false);

      // A second controller for either repository, the whole queue, and a third repository.
      for (const args of [['start', '--repo', alpha], ['start']]) {
        const r = cli(home, ...args);
        expect(r.code).toBe(1);
        expect(r.err).toContain('already running');
      }
      const none = cli(home, 'stop', '--repo', makeRepo('git@github.com:acme/gamma.git'));
      expect(none.code).toBe(1);
      expect(none.err).toContain('github.com/acme/gamma; there is one for:');

      const text = cli(home, 'status').out;
      expect(text).toContain(`controller  running (PID ${String(process.pid)}), ${ALPHA}`);
      expect(text).toContain(`controller  running (PID ${String(process.pid)}), ${BETA}`);
      expect(text).toContain('stop        after the current ticket');
      expect(text).toContain('stop        not requested');
      const data = json<RunnerStatus>(cli(home, 'status', '--json'));
      expect(data.controllers.map((c) => c.scope).sort()).toEqual([ALPHA, BETA]);
    } finally {
      a();
      b();
    }
    // Both released with their sessions unfinished: two interrupted sessions.
    const resume = cli(home, 'resume');
    expect(resume.code).toBe(2);
    expect(resume.err).toContain(ALPHA);
    expect(cli(home, 'stop', '--repo', alpha).out).toContain('discarded');
    expect(cli(home, 'stop').out).toContain('discarded');
    const idle = cli(home, 'status');
    expect(idle.out).toContain('controller  idle');
    expect(idle.out).toContain('Nothing is running. orch start resumes a stranded');
    expect(cli(home, 'stop').err).toContain('nothing to stop');
    expect(cli(home, 'resume').err).toContain('nothing to resume');
  });
});

describe('a legacy root record', () => {
  it('is listed as interrupted under its path, refuses a scoped start, and is discarded by orch stop', () => {
    const home = tempDir();
    writeSession(homePaths(home), record({ pid: 2 ** 31 - 1, repo: alpha }));

    expect(cli(home, 'status').out).toContain(`controller  interrupted, ${alpha}`);
    const start = cli(home, 'start', '--repo', beta);
    expect(start.code).toBe(1);
    expect(start.err).toContain('was interrupted');
    const stop = cli(home, 'stop');
    expect(stop.code).toBe(0);
    expect(stop.out).toContain('discarded');
    expect(readSession(homePaths(home))?.finished?.reason).toContain('discarded');
    expect(cli(home, 'start', '--repo', beta).code).toBe(0);
  });
});
