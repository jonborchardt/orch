/**
 * `orch verify`: real subprocesses in real worktrees. Policies use `node` so every platform runs
 * the same checks; one test goes through the Windows `.cmd` shim path with npm.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { canonicalPath, installRoot } from '../src/core/paths.ts';
import { parsePolicy, policyFingerprint } from '../src/core/verification.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { planJob } from '../src/ops/factory.ts';
import { showVerification } from '../src/ops/verify.ts';
import { openStore, type Store } from '../src/storage/client.ts';
import { claimJob, getJob } from '../src/storage/jobs.ts';
import { latestRun, listRuns, startRun } from '../src/storage/verification.ts';
import {
  add,
  CHECK_JS,
  type Ctx,
  go,
  head,
  makePolicyRepo,
  SESSION,
  start,
  verify,
} from './drive.ts';
import {
  commitFile,
  gitIn,
  homePaths,
  json,
  orch,
  orchAsync,
  removeLink,
  tempDir,
  type TempStore,
  tempStore,
} from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
const extra: string[] = [];

beforeEach(() => {
  store = tempStore();
  ({ clone, bare } = makePolicyRepo());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare, ...extra.splice(0)]) rmSync(d, { recursive: true, force: true });
});

function policyWith(commands: Record<string, unknown>[]): string {
  return JSON.stringify({ verification: { commands } }, null, 2) + '\n';
}

/** Replace the policy on main (the baseline) and push, before the job is created. */
function setBaselinePolicy(commands: Record<string, unknown>[]): void {
  commitFile(clone, 'factory.json', policyWith(commands), 'policy');
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

function inBuild(c: Ctx, s: Store = store): void {
  go(s, c, 'start');
  add(s, c, 'spec.md');
  go(s, c, 'complete');
  go(s, c, 'start');
}

describe('orch verify: runs and records', () => {
  it('runs every required check in the worktree and records durable evidence', () => {
    setBaselinePolicy([
      { id: 'check', command: 'node', args: ['check.js'] },
      { id: 'where', command: 'node', args: ['-e', 'console.log(process.cwd())'], cwd: 'src' },
    ]);
    const c = start(store, clone);
    inBuild(c);
    commitFile(c.wt, 'src/x.ts', 'x');
    const r = verify(store, c);
    expect(r.status).toBe('passed');
    expect(r.head).toBe(head(c.wt));
    expect(r.checks.map((x) => [x.checkId, x.status, x.exitCode])).toEqual([
      ['check', 'passed', 0],
      ['where', 'passed', 0],
    ]);
    const run = latestRun(store.db, c.id);
    expect(run?.run.status).toBe('passed');
    expect(run?.run.tree).toBe(gitIn(c.wt, 'rev-parse', 'HEAD^{tree}'));
    expect(run?.run.dirty).toEqual([]);
    expect(run?.run.policySource).toBe('baseline');
    expect(run?.run.configFingerprint).toBe(
      policyFingerprint(parsePolicy(JSON.parse(readFileSync(join(clone, 'factory.json'), 'utf8')))),
    );
    for (const ch of run?.checks ?? []) {
      expect(ch.outputPath).toBe(`verification/${String(run?.run.id)}/${ch.checkId}.log`);
      const log = readFileSync(join(c.dir, ...(ch.outputPath ?? '').split('/')), 'utf8');
      expect(ch.outputSha256).toHaveLength(64);
      expect(ch.durationMs).toBeGreaterThanOrEqual(0);
      expect(log).toContain(`command: ${JSON.stringify([ch.command, ...ch.args])}`);
    }
    const where = readFileSync(
      join(c.dir, 'verification', String(run?.run.id), 'where.log'),
      'utf8',
    );
    // The second check ran in <worktree>/src, never in the initiating checkout.
    expect(where.toLowerCase()).toContain(canonicalPath(join(c.wt, 'src')).toLowerCase());
    expect(where.toLowerCase()).not.toContain(canonicalPath(clone).toLowerCase());
    const status = showVerification(store, c.id);
    expect(status?.valid).toBe(true);
    expect(planJob(store, c.id).verification?.valid).toBe(true);
    // The build plan always tells the builder to verify; the gate decides whether it was enough.
    expect(planJob(store, c.id).commands).toContain(`orch verify ${c.id} --token <token>`);
    // Build can now complete with the run as evidence.
    add(store, c, 'build.md');
    expect(go(store, c, 'complete').stage).toBe('review');
  });

  it('stops at the first failed required check, leaves the rest pending, and blocks the gate', () => {
    setBaselinePolicy([
      { id: 'lint', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'check', command: 'node', args: ['check.js'] },
      { id: 'after', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'opt', command: 'node', args: ['-e', 'process.exit(3)'], required: false },
    ]);
    const c = start(store, clone);
    inBuild(c);
    commitFile(c.wt, 'marker.txt', 'BREAK\n');
    const r = verify(store, c);
    expect(r.status).toBe('failed');
    expect(r.checks.map((x) => [x.checkId, x.status])).toEqual([
      ['lint', 'passed'],
      ['check', 'failed'],
      ['after', 'pending'],
      ['opt', 'pending'],
    ]);
    expect(r.checks[1]?.exitCode).toBe(1);
    expect(r.hint).toContain('check failed');
    const log = readFileSync(join(c.dir, 'verification', String(r.runId), 'check.log'), 'utf8');
    expect(log).toContain('marker broken');
    add(store, c, 'build.md');
    expect(() => go(store, c, 'complete')).toThrow(/a required check failed/);
    // An optional failure alone does not fail the run.
    commitFile(c.wt, 'marker.txt', 'fixed\n');
    const ok = verify(store, c);
    expect(ok.status).toBe('passed');
    expect(ok.checks.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'failed']);
  });

  it('reports configuration-required when the base branch has no policy, and never invents one', () => {
    const plain = makePolicyRepo('https://github.com/acme/plain.git', null);
    extra.push(plain.clone, plain.bare);
    const c = start(store, plain.clone);
    inBuild(c);
    commitFile(c.wt, 'src/x.ts', 'x');
    const r = verify(store, c);
    expect(r.status).toBe('configuration-required');
    expect(r.runId).toBeNull();
    expect(listRuns(store.db, c.id)).toEqual([]);
    expect(r.hint).toContain('add a factory.json');
    add(store, c, 'build.md');
    expect(() => go(store, c, 'complete')).toThrow(/no verification commands configured/);
    expect(planJob(store, c.id).reason).toContain('No verification policy');
    // The builder proposes one in the worktree: still not effective until a human accepts it.
    commitFile(
      c.wt,
      'factory.json',
      policyWith([{ id: 'check', command: 'node', args: ['check.js'] }]),
    );
    const proposed = verify(store, c);
    expect(proposed.status).toBe('configuration-required');
    expect(proposed.hint).toContain('accept-policy');
    expect(planJob(store, c.id).verification?.policy.authorization).toBe('required');
    go(store, c, 'escalate', 'verification policy needs human acceptance');
    const accepted = dashboardAction(store, c.id, { action: 'accept-policy' });
    expect(accepted.message).toContain('accepted');
    expect(getJob(store.db, c.id).policyHead).toBe(head(c.wt));
    const back = dashboardAction(store, c.id, { action: 'approve', to: 'build' });
    expect(back.job.stage).toBe('build');
    const token = claimJob(store, c.id, { session: SESSION }).token;
    const c2 = { ...c, token };
    go(store, c2, 'start');
    const r2 = verify(store, c2);
    expect(r2.status).toBe('passed');
    expect(r2.policy.source).toBe('authorized');
    add(store, c2, 'build.md', undefined, true);
    expect(go(store, c2, 'complete').stage).toBe('review');
  });

  it('records timeouts, launch failures, bad working directories, and truncated output', () => {
    setBaselinePolicy([
      {
        id: 'slow',
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 30000)'],
        timeoutMs: 1000,
        required: false,
      },
      { id: 'missing', command: 'definitely-not-a-tool-xyz', args: [], required: false },
      { id: 'nocwd', command: 'node', args: ['-e', '0'], cwd: 'does/not/exist', required: false },
      {
        id: 'loud',
        command: 'node',
        args: [
          '-e',
          "process.stdout.write('x'.repeat(700000)); process.stderr.write('e'.repeat(10))",
        ],
        required: false,
      },
    ]);
    const c = start(store, clone);
    inBuild(c);
    const t0 = Date.now();
    const r = verify(store, c);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(r.status).toBe('passed'); // all optional
    const by = Object.fromEntries(r.checks.map((x) => [x.checkId, x]));
    expect(by['slow']?.status).toBe('timed-out');
    expect(by['slow']?.exitCode).toBeNull();
    expect(by['missing']?.status).toBe('error');
    expect(by['missing']?.error).toContain('not found on PATH');
    expect(by['nocwd']?.status).toBe('error');
    expect(by['nocwd']?.error).toContain('does not exist');
    expect(by['loud']?.status).toBe('passed');
    expect(by['loud']?.truncated).toBe(true);
    const log = readFileSync(join(c.dir, 'verification', String(r.runId), 'loud.log'), 'utf8');
    expect(log).toContain('characters truncated by orch');
    expect(log.length).toBeLessThan(400000);
    expect(log).toContain('eeeeeeeeee');
  });

  it.runIf(process.platform === 'win32')(
    'Windows: a timed-out check started through cmd.exe leaves no descendants behind',
    async () => {
      // The check is the shape of `npm test` on Windows: cmd.exe in front of a Node tree.
      const pidFile = join(tempDir('orch-tree-'), 'pids.txt');
      extra.push(join(pidFile, '..'));
      commitFile(
        clone,
        'tree.cjs',
        "const { spawn } = require('node:child_process');\n" +
          "const fs = require('node:fs');\n" +
          'const [file, depth] = [process.argv[2], Number(process.argv[3])];\n' +
          "fs.appendFileSync(file, depth + ':' + process.pid + '\\n');\n" +
          'if (depth < 2) spawn(process.execPath, [__filename, file, String(depth + 1)], { stdio: "ignore" });\n' +
          'setTimeout(() => {}, 60000);\n',
      );
      setBaselinePolicy([
        {
          id: 'tree',
          command: 'cmd',
          args: ['/c', 'node', 'tree.cjs', pidFile, '0'],
          timeoutMs: 4000,
          required: false,
        },
      ]);
      const c = start(store, clone);
      inBuild(c);
      const r = verify(store, c);
      const tree = r.checks.find((x) => x.checkId === 'tree');
      expect(tree?.status).toBe('timed-out');
      expect(tree?.error).toBeNull(); // every descendant was terminated
      const log = readFileSync(join(c.dir, 'verification', String(r.runId), 'tree.log'), 'utf8');
      expect(log).toMatch(/descendants: killed [1-9]/);
      const pids = readFileSync(pidFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => Number(l.split(':')[1]));
      expect(pids.length).toBeGreaterThan(0);
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      };
      const until = Date.now() + 3000;
      while (pids.some(alive) && Date.now() < until) await new Promise((w) => setTimeout(w, 100));
      expect(pids.filter(alive)).toEqual([]);
    },
  );

  it('refuses a working directory that is a link out of the worktree', () => {
    setBaselinePolicy([{ id: 'esc', command: 'node', args: ['-e', '0'], cwd: 'link' }]);
    const c = start(store, clone);
    inBuild(c);
    const outside = tempDir('orch-outside-');
    extra.push(outside);
    try {
      symlinkSync(outside, join(c.wt, 'link'), 'junction');
    } catch {
      return;
    }
    try {
      // Git may or may not list the junction as untracked; make the tree clean either way.
      try {
        gitIn(c.wt, 'add', '-A');
        gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'link');
      } catch {
        /* nothing to commit */
      }
      const r = verify(store, c);
      expect(r.status).toBe('failed');
      expect(r.checks[0]?.error).toContain('outside the worktree');
    } finally {
      removeLink(join(c.wt, 'link'));
    }
  });

  it('runs npm through the platform shim (cmd.exe on Windows) with plain arguments', () => {
    setBaselinePolicy([{ id: 'npm', command: 'npm', args: ['--version'] }]);
    const c = start(store, clone);
    inBuild(c);
    const r = verify(store, c);
    expect(r.status).toBe('passed');
    const log = readFileSync(join(c.dir, 'verification', String(r.runId), 'npm.log'), 'utf8');
    expect(log).toMatch(/\d+\.\d+\.\d+/);
  });

  it('handles worktrees, data dirs, and arguments with spaces', () => {
    const home = join(tempDir('orch home '), 'data dir');
    mkdirSync(home, { recursive: true });
    extra.push(home);
    const spaced = openStore(homePaths(home));
    try {
      const repo = makePolicyRepo('https://github.com/acme/spaced.git', {
        verification: {
          commands: [
            { id: 'check', command: 'node', args: ['check.js'] },
            {
              id: 'arg',
              command: 'node',
              args: ['-e', "if (process.argv[1] !== 'two words') process.exit(1)", 'two words'],
            },
          ],
        },
      });
      extra.push(repo.clone, repo.bare);
      const r0 = (() => {
        const c = start(spaced, repo.clone, 'Spaces every where');
        inBuild(c, spaced);
        return { c, r: verify(spaced, c) };
      })();
      expect(r0.c.wt).toContain('data dir');
      expect(r0.r.status).toBe('passed');
      expect(r0.r.checks.map((x) => x.status)).toEqual(['passed', 'passed']);
    } finally {
      spaced.close();
    }
  });
});

describe('orch verify: identity, ownership, concurrency', () => {
  it('refuses a dirty or untracked worktree and a stale token', () => {
    const c = start(store, clone);
    inBuild(c);
    writeFileSync(join(c.wt, 'untracked.txt'), 'x');
    expect(() => verify(store, c)).toThrow(/uncommitted changes/);
    rmSync(join(c.wt, 'untracked.txt'));
    writeFileSync(join(c.wt, 'marker.txt'), 'edited');
    expect(() => verify(store, c)).toThrow(ValidationError);
    gitIn(c.wt, 'checkout', '--', 'marker.txt');
    expect(listRuns(store.db, c.id)).toEqual([]);
    expect(() => verify(store, { ...c, token: 'bad' })).toThrow(OwnershipError);
    claimJob(store, c.id, { session: 'thief', force: true });
    expect(() => verify(store, c)).toThrow(OwnershipError);
  });

  it('evidence goes stale when the commit or the policy changes', () => {
    const c = start(store, clone);
    inBuild(c);
    expect(verify(store, c).status).toBe('passed');
    expect(showVerification(store, c.id)?.valid).toBe(true);
    commitFile(c.wt, 'src/y.ts', 'y');
    const s1 = showVerification(store, c.id);
    expect(s1?.valid).toBe(false);
    expect(s1?.reason).toMatch(/it ran at/);
    expect(verify(store, c).status).toBe('passed');
    expect(showVerification(store, c.id)?.valid).toBe(true);
    // A human accepts a different policy: the fingerprint changes and the run is stale.
    commitFile(
      c.wt,
      'factory.json',
      policyWith([
        { id: 'check', command: 'node', args: ['check.js'] },
        { id: 'extra', command: 'node', args: ['-e', '0'] },
      ]),
    );
    expect(verify(store, c).status).toBe('passed'); // still the baseline: one check
    expect(latestRun(store.db, c.id)?.checks.map((x) => x.checkId)).toEqual(['check']);
    go(store, c, 'escalate', 'policy');
    dashboardAction(store, c.id, { action: 'accept-policy' });
    const s2 = showVerification(store, c.id);
    expect(s2?.valid).toBe(false);
    expect(s2?.reason).toMatch(/policy changed/);
    const token = claimJob(store, c.id, { session: SESSION }).token;
    const r = verify(store, { ...c, token });
    expect(r.checks.map((x) => x.checkId)).toEqual(['check', 'extra']);
    expect(r.policy.source).toBe('authorized');
  });

  it('an interrupted run is never evidence and is marked when the next run starts', () => {
    const c = start(store, clone);
    inBuild(c);
    const ghost = startRun(store, c.id, {
      token: c.token,
      head: head(c.wt),
      tree: gitIn(c.wt, 'rev-parse', 'HEAD^{tree}'),
      dirty: [],
      configFingerprint: showVerification(store, c.id)?.policy.fingerprint ?? '',
      policySource: 'baseline',
      policyHead: null,
      checks: [
        {
          id: 'check',
          command: 'node',
          args: ['check.js'],
          cwd: '.',
          required: true,
          timeoutMs: 1000,
        },
      ],
    });
    expect(ghost.checks[0]?.status).toBe('pending');
    const s = showVerification(store, c.id);
    expect(s?.valid).toBe(false);
    expect(s?.reason).toBe('the run did not finish');
    add(store, c, 'build.md');
    expect(() => go(store, c, 'complete')).toThrow(/did not finish/);
    const next = verify(store, c);
    expect(next.status).toBe('passed');
    expect(listRuns(store.db, c.id).map((r) => r.status)).toEqual(['passed', 'interrupted']);
  });

  it('a check that steals ownership leaves the run incomplete: the result is never recorded', () => {
    const main = join(installRoot(), 'src', 'cli', 'main.ts');
    setBaselinePolicy([
      {
        id: 'thief',
        command: 'node',
        args: [main, 'job', 'claim', 'JOB', '--session', 'thief', '--force'],
      },
      { id: 'check', command: 'node', args: ['check.js'] },
    ]);
    const d = start(store, clone, 'Second');
    // The policy cannot know the job id at commit time: put it on main now and move the job's
    // merge base forward by merging the base, so the baseline is the id-specific policy.
    commitFile(
      clone,
      'factory.json',
      readFileSync(join(clone, 'factory.json'), 'utf8').replace('JOB', d.id),
      'policy with id',
    );
    gitIn(clone, 'push', '-q', 'origin', 'main');
    inBuild(d);
    gitIn(d.wt, 'fetch', '-q', 'origin', 'main');
    gitIn(
      d.wt,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'merge',
      '-q',
      '--no-edit',
      'origin/main',
    );
    const previous = process.env['ORCH_HOME'];
    process.env['ORCH_HOME'] = store.home;
    try {
      expect(() => verify(store, d)).toThrow(OwnershipError);
    } finally {
      if (previous === undefined) delete process.env['ORCH_HOME'];
      else process.env['ORCH_HOME'] = previous;
    }
    const run = latestRun(store.db, d.id);
    expect(run?.run.status).toBe('running');
    expect(run?.checks.map((x) => x.status)).toEqual(['pending', 'pending']);
    expect(getJob(store.db, d.id).ownerSession).toBe('thief');
    expect(planJob(store, d.id).verification?.reason).toBe('the run did not finish');
  });

  it('several jobs verify at the same time through the CLI, from an unrelated directory', async () => {
    const c = start(store, clone, 'First');
    const d = start(store, clone, 'Second');
    for (const x of [c, d]) inBuild(x);
    setBaselinePolicy([
      { id: 'slow', command: 'node', args: ['-e', 'setTimeout(() => process.exit(0), 400)'] },
    ]);
    const e = start(store, clone, 'Third'); // baseline with the slow check
    inBuild(e);
    const elsewhere = tmpdir();
    const results = await Promise.all(
      [c, d, e].map((x) =>
        orchAsync(store.home, elsewhere, ['--json', 'verify', x.id, '--token', x.token]),
      ),
    );
    for (const [i, r] of results.entries()) {
      expect(r.code, r.err).toBe(0);
      const out = json<{ status: string; runId: number }>(r);
      expect(out.status).toBe('passed');
      expect(latestRun(store.db, [c, d, e][i]?.id ?? '')?.run.id).toBe(out.runId);
    }
    // `verify show` is read-only and works without a token; failures exit 1.
    const shown = json<{ valid: boolean }>(
      orch(store.home, elsewhere, ['--json', 'verify', 'show', c.id]),
    );
    expect(shown.valid).toBe(true);
    commitFile(e.wt, 'marker.txt', 'BREAK\n');
    const bad = orch(store.home, elsewhere, ['--json', 'verify', e.id, '--token', e.token]);
    expect(bad.code).toBe(0); // the slow check ignores marker.txt
    commitFile(c.wt, 'marker.txt', 'BREAK\n');
    const failed = orch(store.home, elsewhere, ['--json', 'verify', c.id, '--token', c.token]);
    expect(failed.code).toBe(1);
    expect(json<{ status: string }>(failed).status).toBe('failed');
    expect(orch(store.home, elsewhere, ['verify']).code).toBe(2);
    expect(orch(store.home, elsewhere, ['verify', c.id, '--token', 'nope']).code).toBe(4);
  });

  it('the policy parser rejects shell strings, paths, traversal, and unknown keys', () => {
    const bad = [
      { verification: { commands: [{ id: 'x', command: 'npm test' }] } },
      { verification: { commands: [{ id: 'x', command: './run.sh' }] } },
      { verification: { commands: [{ id: 'x', command: 'node', cwd: '../elsewhere' }] } },
      { verification: { commands: [{ id: 'x', command: 'node', cwd: '/abs' }] } },
      { verification: { commands: [{ id: 'x', command: 'node', args: 'a b' }] } },
      { verification: { commands: [{ id: 'x', command: 'node', shell: true }] } },
      {
        verification: {
          commands: [
            { id: 'x', command: 'node' },
            { id: 'x', command: 'node' },
          ],
        },
      },
      { verification: { commands: [{ id: 'Bad Id', command: 'node' }] } },
      { verification: { commands: [{ id: 'x', command: 'node', timeoutMs: 10 }] } },
      { models: {} },
      [],
    ];
    for (const b of bad) expect(() => parsePolicy(b), JSON.stringify(b)).toThrow(ValidationError);
    expect(parsePolicy({})).toEqual({ commands: [] });
    const p = parsePolicy({
      verification: { commands: [{ id: 'a', command: 'node', cwd: './ui\\x' }] },
    });
    expect(p.commands[0]).toMatchObject({ cwd: 'ui/x', required: true, args: [] });
    expect(existsSync(join(installRoot(), 'factory.json'))).toBe(true);
    expect(() =>
      parsePolicy(JSON.parse(readFileSync(join(installRoot(), 'factory.json'), 'utf8'))),
    ).not.toThrow();
    expect(CHECK_JS).toContain('BREAK');
  });
});
