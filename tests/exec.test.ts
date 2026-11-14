/**
 * `spawnCommand` and what happens to a command's process tree when it is killed. Trees are real:
 * a Node script that spawns a child which spawns a grandchild, each writing its pid under a
 * per-test tag, started through the platform shell the way the npm shim is. Nothing here kills by
 * executable name; every pid asserted on or terminated was recorded by the tree itself.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { descendantsOf, type ProcRow, spawnCommand, sweepDescendants } from '../src/core/exec.ts';
import { tempDir } from './helpers.ts';

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

/** Run the tree through a shell, as `spawnCommand` runs npm, with a short timeout. */
function timedOutTree(tag: string, mode = '', timeout = 4000) {
  const file = join(dir, `${tag}.pids`);
  trees.push(file);
  const r = WIN
    ? spawnCommand('cmd', ['/c', process.execPath, script, file, '0', mode], { timeout })
    : spawnCommand('sh', ['-c', `"${process.execPath}" "${script}" "${file}" 0 ${mode}`], {
        timeout,
      });
  return { r, file };
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
      const sibling = timedSibling('sibling');
      const { r, file } = timedOutTree('tree');
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
    const { r, file } = timedOutTree('leaf', 'leaf-exits');
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
      const { r, file } = timedOutTree('posix');
      expect(r).toMatchObject({ status: null, timedOut: true, signal: 'SIGKILL' });
      expect(r.cleanup).toBeUndefined();
      // The shell is the direct child and dies; the Node tree under it is reaped by afterEach.
      expect(pidsIn(file).length).toBeGreaterThan(0);
      await Promise.resolve();
    },
  );
});

/** An independent tree (detached, its own stdio) that must survive another tree's cleanup. */
function timedSibling(tag: string): string {
  const file = join(dir, `${tag}.pids`);
  trees.push(file);
  const child = spawn(process.execPath, [script, file, '0'], { stdio: 'ignore', detached: true });
  child.unref();
  // Give the whole sibling tree time to start before the test's own tree times out.
  const until = Date.now() + 10_000;
  while (pidsIn(file).length < 3 && Date.now() < until) {
    /* spin: spawnSync-based callers block anyway */
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
