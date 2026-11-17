/** `orch recover` from the CLI: a temp ORCH_HOME, cwd outside the repo, gh through the shim. */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { alive } from '../src/ops/verify-lock.ts';
import { freshRecord, HEARTBEAT_STALE_SECONDS } from '../src/ops/recover.ts';
import { ghShim, json, makeRepo, orch, tempDir } from './helpers.ts';

const shim = ghShim();
const home = tempDir();
const cwd = tmpdir();
const cli = (...args: string[]) => orch(home, cwd, args, shim.env);

interface Status {
  running: boolean;
  pid: number | null;
  last: { online: boolean; jobs: { jobId: string; class: string; resume: string | null }[] } | null;
}

afterAll(() => {
  cli('recover', 'stop'); // never leave a worker behind, whatever failed
  shim.cleanup();
});

describe('orch recover', () => {
  it('start, refuse a second start, status, stop', () => {
    expect(json<Status>(cli('recover', 'status', '--json'))).toMatchObject({
      running: false,
      pid: null,
    });

    const started = json<Status>(cli('recover', 'start', '--json'));
    expect(started.running).toBe(true);
    expect(started.pid).toEqual(expect.any(Number));
    const live = json<Status>(cli('recover', 'status', '--json'));
    expect(live).toMatchObject({ running: true, pid: started.pid });

    const again = cli('recover', 'start');
    expect(again.code).toBe(1);
    expect(again.err).toContain('already running');
    const once = cli('recover', 'run', '--once');
    expect(once.code).toBe(1);
    expect(once.err).toContain('already running');

    const stopped = cli('recover', 'stop', '--json');
    expect(stopped.code).toBe(0);
    expect(json(stopped)).toEqual({ stopped: true, pid: started.pid });
    expect(json<Status>(cli('recover', 'status', '--json'))).toMatchObject({
      running: false,
      pid: null,
    });
  });

  it('run --once exits 0, prints the pass, and status reports needs-session jobs', () => {
    const repo = makeRepo();
    const created = json<{ jobId: string }>(
      cli('job', 'create', '--title', 'Spec only', '--repo', repo, '--json'),
    );
    const r = cli('recover', 'run', '--once', '--json');
    expect(r.code).toBe(0);
    const pass = json<NonNullable<Status['last']>>(r);
    expect(pass.online).toBe(true);
    expect(pass.jobs).toContainEqual(
      expect.objectContaining({ jobId: created.jobId, class: 'needs-session' }),
    );

    const status = json<Status>(cli('recover', 'status', '--json'));
    expect(status.running).toBe(false);
    const listed = status.last?.jobs.find((j) => j.jobId === created.jobId);
    expect(listed).toMatchObject({ class: 'needs-session' });
    expect(listed?.resume).toContain(`/factory ${created.jobId}`);

    const text = cli('recover', 'run', '--once');
    expect(text.code).toBe(0);
    expect(text.out).toContain('needs-session');
  });

  it('never signals the PID of a stale PID file', () => {
    // An unrelated live process holds the PID a worker had before a reboot.
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      const pid = other.pid ?? 0;
      writeFileSync(
        join(home, 'recovery.pid'),
        JSON.stringify({ pid, startedAt: '2000-01-01T00:00:00.000Z' }),
      );
      expect(json<Status>(cli('recover', 'status', '--json'))).toMatchObject({
        running: false,
        pid: null,
      });
      expect(json(cli('recover', 'stop', '--json'))).toEqual({ stopped: false, pid: null });
      expect(alive(pid)).toBe(true);
    } finally {
      other.kill();
    }
  });
});

describe('freshRecord', () => {
  const boot = Date.parse('2026-11-17T08:00:00.000Z');
  const at = (min: number) => new Date(boot + min * 60_000).toISOString();
  const nowMs = boot + 120 * 60_000;

  it('rejects a record written before the last boot', () => {
    expect(freshRecord({ pid: 1, startedAt: at(-1), beatAt: at(119) }, nowMs, boot)).toBe(false);
  });

  it('rejects a heartbeat older than the stale limit, accepts a recent one', () => {
    const limitMin = HEARTBEAT_STALE_SECONDS / 60;
    expect(freshRecord({ pid: 1, startedAt: at(0), beatAt: at(119 - limitMin) }, nowMs, boot)).toBe(
      false,
    );
    expect(freshRecord({ pid: 1, startedAt: at(0), beatAt: at(119) }, nowMs, boot)).toBe(true);
    // No beat yet: the start time stands in for it.
    expect(freshRecord({ pid: 1, startedAt: at(0) }, nowMs, boot)).toBe(false);
    expect(freshRecord({ pid: 1, startedAt: at(110) }, nowMs, boot)).toBe(true);
  });
});
