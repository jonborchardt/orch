/**
 * The controller lock's exclusive takeover, with the race forced rather than hoped for: this
 * starter judges a dead controller's lock stale, and before it claims the next generation a
 * competitor claims it. The competitor is a real `acquireRunnerLock`, run from inside this
 * starter's liveness check (the one moment between its look and its claim).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runnerPaths, type RuntimePaths } from '../src/core/paths.ts';
import { acquireRunnerLock, type RunnerLock } from '../src/ops/runner-state.ts';
import { homePaths, tempDir } from './helpers.ts';

const DEAD = 2 ** 31 - 1;
const race: { paths: RuntimePaths | null; competitor: RunnerLock | null; claimed: Buffer | null } =
  { paths: null, competitor: null, claimed: null };

vi.mock('../src/ops/verify-lock.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/ops/verify-lock.ts')>();
  return {
    ...real,
    alive: (pid: number) => {
      if (pid === DEAD && race.paths) {
        const paths = race.paths;
        race.paths = null; // the competitor's own look finds the dead pid dead, and claims
        race.competitor = acquireRunnerLock(paths);
        race.claimed = readFileSync(join(runnerPaths(paths).lock, '2'));
      }
      return real.alive(pid);
    },
  };
});

describe('controller lock: a competitor claims between the look and the claim', () => {
  it('refuses the late starter and leaves the competitor holding its generation', () => {
    const paths = homePaths(tempDir('orch-runner-lock-'));
    const dir = runnerPaths(paths).lock;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '1'),
      JSON.stringify({ pid: DEAD, startedAt: new Date().toISOString() }),
    );

    race.paths = paths;
    expect(() => acquireRunnerLock(paths)).toThrow(/already running/);
    // The competitor took generation 2 while the late starter was judging generation 1.
    expect(race.competitor?.owned()).toBe(true);
    expect(JSON.parse(String(race.claimed))).toMatchObject({ pid: process.pid });
    // The refused starter overwrote nothing, added no generation, and left no tmp file.
    expect(readFileSync(join(dir, '2')).equals(race.claimed ?? Buffer.alloc(0))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['1', '2']);
  });
});
