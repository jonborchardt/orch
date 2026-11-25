/**
 * `spawnCommand` and what happens to a command's process tree when it is killed. Trees are real:
 * a Node script that spawns a child which spawns a grandchild, each writing its pid under a
 * per-test tag, started through the platform shell the way the npm shim is. Nothing here kills by
 * executable name; every pid asserted on or terminated was recorded by the tree itself.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../src/core/errors.ts';
import {
  descendantsOf,
  processStartMs,
  type ProcRow,
  spawnCommand,
  spawnTool,
  sweepDescendants,
  whichSync,
} from '../src/core/exec.ts';
import { findProjectRoot } from '../src/core/paths.ts';
import { git } from '../src/git/run.ts';
import { makeRepo, tempDir } from './helpers.ts';

const WIN = process.platform === 'win32';

/** tree.cjs <pidfile> <depth> [leaf-exits]: appends "<depth>:<pid>", spawns depth+1 up to 2, sleeps. */
const TREE = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [file, depth, mode] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
fs.appendFileSync(file, depth + ':' + process.pid + '\n');
if (mode === 'leaf-exits' && depth === 1) process.exit(0);
if (depth < 2) spawn(process.execPath, [__filename, file, String(depth + 1), mode ?? ''], { stdio: 'ignore' });
setTimeout(() => {}, 60_000);
`;

let dir: string;
let script: string;
const trees: string[] = [];

beforeEach(() => {
  dir = tempDir('orch-exec-');
  script = join(dir, 'tree.cjs');
  writeFileSync(script, TREE);
});
afterEach(() => {
  // Whatever a test left running is stopped by its recorded pids before the directory goes.
  for (const file of trees.splice(0)) for (const pid of pidsIn(file)) kill(pid);
  rmSync(dir, { recursive: true, force: true });
});

function pidsIn(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => Number(l.split(':')[1]));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Wait until every recorded pid is dead or `ms` elapsed; returns the survivors. */
async function survivors(file: string, ms = 3000): Promise<number[]> {
  const until = Date.now() + ms;
  for (;;) {
    const left = pidsIn(file).filter(alive);
    if (left.length === 0 || Date.now() > until) return left;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Run the tree through a shell, as `spawnCommand` runs npm, until it times out with all `count`
 * processes started. A loaded machine can take longer than the 4 s timeout to start three Node
 * processes; such a run is still swept and must leave nothing behind, and is repeated with twice
 * the time (up to 32 s) instead of being judged on a tree that never finished starting.
 */
async function timedOutTree(tag: string, count: number, mode = '') {
  for (let timeout = 4000, attempt = 1; ; timeout *= 2, attempt++) {
    const file = join(dir, `${tag}-${String(attempt)}.pids`);
    trees.push(file);
    const r = WIN
      ? spawnCommand('cmd', ['/c', process.execPath, script, file, '0', mode], { timeout })
      : spawnCommand('sh', ['-c', `"${process.execPath}" "${script}" "${file}" 0 ${mode}`], {
          timeout,
        });
    if (pidsIn(file).length >= count || timeout >= 32_000) return { r, file };
    expect(r.timedOut).toBe(true);
    if (WIN) {
      expect(r.cleanup?.failed).toEqual([]);
      expect(r.cleanup?.error).toBeUndefined();
      expect(await survivors(file)).toEqual([]);
    }
  }
}

describe('spawnCommand', () => {
  it('reports an ordinary completion without any cleanup', () => {
    const r = spawnCommand('node', ['-e', 'console.log("hi")'], { timeout: 20_000 });
    expect(r).toMatchObject({ status: 0, stdout: 'hi\n', signal: null });
    expect(r.timedOut).toBeUndefined();
    expect(r.cleanup).toBeUndefined();
  });

  it('kills a direct child on timeout and reports the timeout, not an exit status', () => {
    const t0 = Date.now();
    const r = spawnCommand('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 1000 });
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(r).toMatchObject({ status: null, timedOut: true, signal: 'SIGKILL' });
    expect(r.error).toBeUndefined();
    // No descendants: on Windows the sweep ran and found nothing; elsewhere there is no sweep.
    if (WIN) expect(r.cleanup).toEqual({ killed: [], failed: [] });
    else expect(r.cleanup).toBeUndefined();
  });

  it.runIf(WIN)(
    'Windows: a timed-out shell takes its children and grandchildren with it',
    async () => {
      const sibling = await timedSibling('sibling');
      const { r, file } = await timedOutTree('tree', 3);
      expect(r).toMatchObject({ status: null, timedOut: true });
      const recorded = pidsIn(file);
      expect(recorded).toHaveLength(3); // root, child, grandchild all started before the timeout
      expect(r.cleanup?.failed).toEqual([]);
      expect(r.cleanup?.error).toBeUndefined();
      // Every process the tree recorded was terminated by the sweep, by pid.
      for (const pid of recorded) expect(r.cleanup?.killed).toContain(pid);
      expect(await survivors(file)).toEqual([]);
      // An unrelated tree started alongside is untouched: the sweep follows parent links only.
      expect(pidsIn(sibling)).toHaveLength(3);
      for (const pid of pidsIn(sibling)) expect(alive(pid)).toBe(true);
    },
  );

  it.runIf(WIN)('Windows: a child that already exited is not an error', async () => {
    const { r, file } = await timedOutTree('leaf', 2, 'leaf-exits');
    expect(r.timedOut).toBe(true);
    const [root, leaf] = pidsIn(file);
    expect(root).toBeDefined();
    expect(r.cleanup).toMatchObject({ failed: [] });
    expect(r.cleanup?.killed).toContain(root);
    expect(r.cleanup?.killed).not.toContain(leaf); // gone before the sweep: nothing to kill
    expect(await survivors(file)).toEqual([]);
  });

  it.runIf(!WIN)(
    'POSIX: behaviour is unchanged, the direct child is killed on timeout',
    async () => {
      const { r, file } = await timedOutTree('posix', 1);
      expect(r).toMatchObject({ status: null, timedOut: true, signal: 'SIGKILL' });
      expect(r.cleanup).toBeUndefined();
      // The shell is the direct child and dies; the Node tree under it is reaped by afterEach.
      expect(pidsIn(file).length).toBeGreaterThan(0);
    },
  );
});

/** An independent tree (detached, its own stdio) that must survive another tree's cleanup. */
async function timedSibling(tag: string): Promise<string> {
  const file = join(dir, `${tag}.pids`);
  trees.push(file);
  const child = spawn(process.execPath, [script, file, '0'], { stdio: 'ignore', detached: true });
  child.unref();
  // The whole sibling tree is running before the test's own tree starts, however long that takes.
  const until = Date.now() + 120_000;
  while (pidsIn(file).length < 3 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return file;
}

describe('sweepDescendants', () => {
  const row = (pid: number, ppid: number, created: number): ProcRow => ({ pid, ppid, created });

  it('walks parent links from a dead root and excludes processes older than the command', () => {
    const table = [
      row(10, 1, 50), // unrelated: created before the command started
      row(11, 10, 150), // child of 10 (a reused pid), but 10 itself is excluded, so 11 is too
      row(20, 100, 120), // child of the root
      row(21, 20, 130), // grandchild
      row(22, 21, 140), // great-grandchild
      row(30, 100, 90), // shares the root's pid as parent but predates the command: pid reuse
      row(31, 30, 160),
    ];
    expect(descendantsOf(table, 100, 100).sort()).toEqual([20, 21, 22]);
    expect(descendantsOf(table, 999, 0)).toEqual([]);
    // A cycle in a corrupt table terminates.
    expect(descendantsOf([row(1, 2, 5), row(2, 1, 5)], 1, 0)).toEqual([2]);
  });

  it('reports an unreadable process table instead of guessing', () => {
    const out = sweepDescendants(12345, 0, () => {
      throw new Error('powershell exited 1: boom');
    });
    expect(out).toEqual({ killed: [], failed: [], error: 'powershell exited 1: boom' });
  });

  it('reads the table once more when a read fails, before giving up', async () => {
    // A cold PowerShell under load misses its timeout once; the second read sees the descendant.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid ?? 0;
    const exited = new Promise((r) => child.on('exit', r));
    let calls = 0;
    const out = sweepDescendants(500, 0, () => {
      calls++;
      if (calls === 1) throw new Error('spawnSync powershell.exe ETIMEDOUT');
      return calls === 2 ? [row(pid, 500, 10)] : [];
    });
    expect(out).toEqual({ killed: [pid], failed: [] });
    expect(calls).toBe(3); // the failed read, its retry, and the pass that found nothing
    await exited;
  });

  it('distinguishes already-gone pids from ones that refuse to die, and stops after 3 passes', () => {
    // 2147483000 cannot exist; it is a descendant per the table and simply gone (ESRCH).
    let calls = 0;
    const gone = sweepDescendants(500, 0, () => {
      calls++;
      return [row(2147483000, 500, 10)];
    });
    expect(gone).toEqual({ killed: [], failed: [] });
    expect(calls).toBe(3);
  });

  it.runIf(WIN)('Windows: a process that cannot be terminated is reported as failed', () => {
    // pid 4 is the System process: TerminateProcess is refused (EPERM), never ESRCH.
    const out = sweepDescendants(777, 0, () => [row(4, 777, 10)]);
    expect(out.failed).toEqual([4]);
    expect(out.killed).toEqual([]);
  });
});

describe('processStartMs', () => {
  it("reads this process's start time and gives null for a PID nobody has", () => {
    const started = processStartMs(process.pid);
    expect(started).not.toBeNull();
    expect(Math.abs((started ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
    expect(processStartMs(2 ** 31 - 1)).toBeNull();
    expect(processStartMs(-1)).toBeNull();
  }, 150_000);
});

/** A copy of `env` without the named keys, matched case-insensitively (Windows env spelling). */
function without(env: NodeJS.ProcessEnv, ...names: string[]): NodeJS.ProcessEnv {
  const drop = names.map((n) => n.toUpperCase());
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.includes(k.toUpperCase())));
}

const NO_CWD_SEARCH = 'NoDefaultCurrentDirectoryInExePath';

/**
 * Plant a fake `git` in `cwd` that writes `<cwd>/ran` when started. Windows: a copy of node.exe
 * named git.exe, which runs the `rev-parse` script beside it; POSIX: an executable shell script.
 */
function plantGit(cwd: string): string {
  if (WIN) {
    copyFileSync(process.execPath, join(cwd, 'git.exe'));
    writeFileSync(
      join(cwd, 'rev-parse'),
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran'), '');\n",
    );
  } else {
    writeFileSync(join(cwd, 'git'), '#!/bin/sh\ntouch "$(dirname "$0")/ran"\n');
    chmodSync(join(cwd, 'git'), 0o755);
  }
  return join(cwd, 'ran');
}

describe('git is never started from the working directory', () => {
  let repo: string;
  let marker: string;
  // libuv reads this from orch's own environment, so the control needs it gone from both.
  const saved = process.env[NO_CWD_SEARCH];
  const env = without(process.env, NO_CWD_SEARCH);
  beforeAll(() => {
    repo = makeRepo();
    marker = plantGit(repo);
    delete process.env['NoDefaultCurrentDirectoryInExePath'];
  });
  afterAll(() => {
    if (saved !== undefined) process.env[NO_CWD_SEARCH] = saved;
  });
  afterEach(() => {
    rmSync(marker, { force: true });
  });

  it.runIf(WIN)('control: a bare-name spawn in that directory runs the planted git.exe', () => {
    spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, env });
    expect(existsSync(marker)).toBe(true);
  });

  it('spawnTool runs the real Git found on PATH', () => {
    const r = spawnTool('git', ['rev-parse', '--show-toplevel'], { cwd: repo, env });
    expect(existsSync(marker)).toBe(false);
    expect(r.status).toBe(0);
    expect(resolve(r.stdout.trim())).toBe(resolve(repo));
  });

  it('findProjectRoot runs the real Git found on PATH', () => {
    expect(findProjectRoot(repo)).toBe(resolve(repo));
    expect(existsSync(marker)).toBe(false);
  });

  it('whichSync skips a relative PATH entry, even one that leads to a planted git', () => {
    // Run from the repository so both entries lead to the fake on any drive layout.
    const rel = join('..', basename(repo));
    const fake = WIN ? 'git.exe' : 'git';
    const before = process.cwd();
    process.chdir(repo);
    try {
      expect(existsSync(join('.', fake)) && existsSync(join(rel, fake))).toBe(true);
      const found = whichSync('git', { PATH: ['.', rel].join(delimiter), PATHEXT: '.EXE' });
      expect(found).toBeUndefined();
    } finally {
      process.chdir(before);
    }
  });
});

describe('spawnTool resolution failures', () => {
  it('reports Git missing from PATH, and git() and findProjectRoot follow', () => {
    const empty = tempDir('orch-nopath-');
    const env = { ...without(process.env, 'PATH'), PATH: empty };
    const r = spawnTool('git', ['--version'], { env });
    expect(r.status).toBeNull();
    expect(r.stderr).toContain('git not found on PATH');
    const saved = process.env['PATH'];
    process.env['PATH'] = empty;
    try {
      expect(findProjectRoot(empty)).toBeUndefined();
      expect(() => git(empty, 'status')).toThrow(ToolError);
      expect(() => git(empty, 'status')).toThrow(/git not found on PATH/);
    } finally {
      process.env['PATH'] = saved;
    }
  });

  it.runIf(WIN)('reads a copied env whose path key is spelled Path', () => {
    const found = whichSync('git', { Path: process.env['PATH'], PATHEXT: process.env['PATHEXT'] });
    expect(found && isAbsolute(found)).toBe(true);
    expect(existsSync(found ?? '')).toBe(true);
  });

  it.runIf(WIN)('refuses a name that resolves only to a .cmd shim', () => {
    const shims = tempDir('orch-shim-');
    writeFileSync(join(shims, 'shimmed.cmd'), '@echo off\r\n');
    const r = spawnTool('shimmed', [], { env: { PATH: shims, PATHEXT: '.CMD' } });
    expect(r.status).toBeNull();
    expect(r.stderr).toContain('cannot be started without a shell');
  });
});
