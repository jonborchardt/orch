/**
 * The controller lock under real contention: several processes start at the same instant, all
 * finding the lock of a controller that is dead. Exactly one may proceed, every time. Each round
 * leaves the lock of a process that has really exited, which the next round then competes for.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { installRoot, runnerPaths } from '../src/core/paths.ts';
import { controllerPid } from '../src/ops/runner-state.ts';
import { homePaths, tempDir } from './helpers.ts';

/** Waits for the shared instant, tries once, and holds the lock until it exits. */
const STARTER = String.raw`
import { pathToFileURL } from 'node:url';
const [module, home, at, holdMs] = process.argv.slice(2);
const { acquireRunnerLock } = await import(pathToFileURL(module).href);
const paths = { config: home, data: home, logs: home + '/logs', tmp: home + '/tmp' };
while (Date.now() < Number(at)) { /* spin: every starter leaves the barrier together */ }
try {
  acquireRunnerLock(paths);
  console.log('acquired');
  setTimeout(() => process.exit(0), Number(holdMs));
} catch (err) {
  console.log('refused: ' + err.message);
}
`;

const STARTERS = 6;
const ROUNDS = 5;

function starter(script: string, home: string, at: number): Promise<string> {
  return new Promise((resolve) => {
    const module = join(installRoot(), 'src', 'ops', 'runner-state.ts');
    const child = spawn(process.execPath, [script, module, home, String(at), '1500']);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', () => {
      resolve(out.trim());
    });
  });
}

describe('controller lock: competing starters and a stale lock', () => {
  it('lets exactly one process through in every round', async () => {
    const home = tempDir('orch-runner-lock-');
    const script = join(home, 'starter.mjs');
    writeFileSync(script, STARTER);
    // A controller that died without releasing.
    const dir = runnerPaths(homePaths(home)).lock;
    mkdirSync(dir);
    writeFileSync(
      join(dir, '1'),
      JSON.stringify({ pid: 2 ** 31 - 1, startedAt: new Date().toISOString() }),
    );

    for (let round = 1; round <= ROUNDS; round++) {
      expect(controllerPid(homePaths(home))).toBeNull();
      // Far enough ahead that every process has loaded the module before the barrier.
      const at = Date.now() + 4000;
      const results = await Promise.all(
        Array.from({ length: STARTERS }, () => starter(script, home, at)),
      );
      const won = results.filter((r) => r === 'acquired');
      const lost = results.filter((r) => r.startsWith('refused: '));
      expect(won, `round ${String(round)}: ${results.join(' | ')}`).toHaveLength(1);
      expect(lost).toHaveLength(STARTERS - 1);
    }
    // One generation per winner on top of the dead one, and no leftovers of the losers.
    expect(readdirSync(dir).sort()).toEqual(
      Array.from({ length: ROUNDS + 1 }, (_, i) => String(i + 1)),
    );
  });
});
