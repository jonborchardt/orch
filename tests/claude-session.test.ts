/**
 * The Claude child as a real process (a Node script stands in for `claude` through
 * ORCH_CLAUDE_SHIM): how it is started, that only its exit ends the wait, that it can be ended,
 * and the controller commands through the CLI. No Claude session is ever started.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_RUNNER_CLAUDE_ARGS } from '../src/core/roles.ts';
import { CLAUDE_SHIM_ENV, launchClaude } from '../src/integrations/claude-session.ts';
import { makePolicyRepo } from './drive.ts';
import { type GhShim, ghShim, json, orch, tempDir } from './helpers.ts';

/** Records how it was started, then does what CLAUDE_SHIM_DO says: exit <n>, sleep <ms>, hang. */
const SHIM = String.raw`
const fs = require('node:fs');
const record = { args: process.argv.slice(2), cwd: process.cwd(), session: process.env.ORCH_SESSION ?? null, token: process.env.ORCH_TOKEN ?? null };
fs.appendFileSync(process.env.CLAUDE_SHIM_LOG, JSON.stringify(record) + '\n');
const [what, value] = (process.env.CLAUDE_SHIM_DO || 'exit 0').split(' ');
if (what === 'exit') process.exit(Number(value));
if (what === 'sleep') setTimeout(() => process.exit(0), Number(value));
if (what === 'hang') setInterval(() => undefined, 1000);
`;

let dir: string;
let log: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = tempDir('orch-claude-shim-');
  log = join(dir, 'calls.jsonl');
  const script = join(dir, 'claude-shim.cjs');
  writeFileSync(script, SHIM);
  env = { ...process.env, [CLAUDE_SHIM_ENV]: script, CLAUDE_SHIM_LOG: log };
});

interface Call {
  args: string[];
  cwd: string;
  session: string | null;
  token: string | null;
}
const calls = (): Call[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Call)
    : [];

const start = (what: string) =>
  launchClaude({
    cwd: dir,
    prompt: '/factory job-1a2b3c4d\n\nSecond line with "quotes" & symbols.',
    args: DEFAULT_RUNNER_CLAUDE_ARGS,
    name: 'factory job-1a2b3c4d',
    env: { ...env, CLAUDE_SHIM_DO: what },
  });

describe('launchClaude', () => {
  it('starts claude -p in the given directory with the permission arguments and the whole prompt', async () => {
    const child = start('exit 0');
    expect(await child.done).toEqual({ code: 0, signal: null, error: null });
    const [call] = calls();
    expect(call?.cwd.toLowerCase()).toBe(dir.toLowerCase());
    expect(call?.args[0]).toBe('-p');
    expect(call?.args.slice(1, 1 + DEFAULT_RUNNER_CLAUDE_ARGS.length)).toEqual([
      ...DEFAULT_RUNNER_CLAUDE_ARGS,
    ]);
    expect(call?.args).toContain('Bash(orch *)');
    expect(call?.args).not.toContain('--dangerously-skip-permissions');
    expect(call?.args.join(' ')).not.toContain('bypassPermissions');
    // The prompt arrives as one argument, unparsed by any shell.
    expect(call?.args.at(-1)).toBe('/factory job-1a2b3c4d\n\nSecond line with "quotes" & symbols.');
    expect(call?.args.at(-3)).toBe('--name');
  });

  it('reports a non-zero exit as it is', async () => {
    expect(await start('exit 3').done).toMatchObject({ code: 3, error: null });
  });

  it('waits for a quiet process for as long as it runs', async () => {
    const began = Date.now();
    const child = start('sleep 1500');
    expect(await child.done).toMatchObject({ code: 0 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(1400);
  });

  it('kill ends a running process, and is harmless afterwards', async () => {
    const child = start('hang');
    // Let it start, so there is something to end.
    await new Promise((r) => setTimeout(r, 500));
    expect(calls()).toHaveLength(1);
    child.kill();
    const exit = await child.done;
    expect(exit.error).toBeNull();
    expect(exit.code === 0 && exit.signal === null).toBe(false);
    child.kill();
  });

  it('says how to install claude when it is not on PATH', () => {
    expect(() =>
      launchClaude({ cwd: dir, prompt: 'x', args: [], name: 'n', env: { PATH: dir } }),
    ).toThrow(/claude was not found on PATH/);
  });
});

describe('controller commands through the CLI', () => {
  let home: string;
  let shim: GhShim;
  let repo: { clone: string; bare: string };
  let outside: string;

  beforeEach(() => {
    home = tempDir('orch-run-home-');
    outside = tempDir('orch-run-cwd-');
    shim = ghShim('acme/alpha');
    repo = makePolicyRepo();
  });
  afterEach(() => {
    shim.cleanup();
  });

  it('status, stop, and start with nothing to do', () => {
    expect(json(orch(home, outside, ['status', '--json']))).toMatchObject({
      state: 'idle',
      current: null,
      stop: { next: false, now: false },
    });
    expect(orch(home, outside, ['status']).out).toContain('controller  idle');
    const stop = orch(home, outside, ['stop', 'next']);
    expect(stop.code).toBe(1);
    expect(stop.err).toContain('nothing to stop');
    expect(orch(home, outside, ['stop', 'later']).code).toBe(2);
    expect(orch(home, outside, ['start', 'repo']).code).toBe(2); // not inside a repository
    expect(orch(home, outside, ['resume']).code).toBe(1);
    const start = orch(home, outside, ['start']);
    expect(start.code).toBe(0);
    expect(start.out).toContain('no ready ticket is left');
    expect(orch(home, outside, ['do', '7']).code).toBe(3);
    expect(orch(home, outside, ['start', '--help']).out).toContain('stop next ');
  });

  it('orch do runs the ticket of another repository in a real child and reads the job, not the exit code', () => {
    const e = { ...shim.env, [CLAUDE_SHIM_ENV]: env[CLAUDE_SHIM_ENV], CLAUDE_SHIM_LOG: log };
    expect(orch(home, repo.clone, ['ticket', 'add', 'Export CSV'], e).code).toBe(0);

    // Not opted in: refused, nothing started.
    const refused = orch(home, outside, ['do', '1', '--json'], e);
    expect(refused.code).toBe(1);
    expect(json<{ tickets: { outcome: string }[] }>(refused).tickets[0]?.outcome).toBe('refused');
    expect(calls()).toHaveLength(0);

    expect(
      orch(home, outside, ['factory', 'config', 'merge', 'enable', '--repo', repo.clone], e).code,
    ).toBe(0);
    const r = orch(home, outside, ['do', '1', '--json'], { ...e, CLAUDE_SHIM_DO: 'exit 0' });
    const summary = json<{
      stopped: boolean;
      tickets: { outcome: string; jobId: string; reason: string }[];
    }>(r);
    // Exit code 0 twice, and the job never moved: blocked, not done.
    expect(r.code).toBe(1);
    expect(summary.tickets[0]?.outcome).toBe('blocked');
    expect(r.err).toContain('claude: exited (code 0); job is spec/');
    const started = calls();
    expect(started).toHaveLength(2);
    const jobId = summary.tickets[0]?.jobId ?? '';
    const job = json<{ job: { worktreePath: string; status: string; ownerSession: null } }>(
      orch(home, outside, ['job', 'show', jobId, '--json']),
    ).job;
    expect(started[0]?.cwd.toLowerCase()).toBe(job.worktreePath.toLowerCase());
    expect(started[0]?.session).toBe('orch-runner');
    expect(started[0]?.token).toBeNull();
    expect(started[0]?.args.at(-1)).toContain(`/factory ${jobId}`);
    expect(job.status).not.toBe('cancelled');
    expect(job.ownerSession).toBeNull();
    expect(json(orch(home, outside, ['status', '--json']))).toMatchObject({ state: 'idle' });
  });
});
