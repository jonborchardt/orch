/** `orch recover` from the CLI: a temp ORCH_HOME, cwd outside the repo, gh through the shim. */
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';

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
});
