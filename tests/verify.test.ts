/**
 * `orch verify`: real subprocesses in real worktrees. Policies use `node` so every platform runs
 * the same checks; one test goes through the Windows `.cmd` shim path with npm.
 */
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath } from '../src/core/paths.ts';
import { parsePolicy, policyFingerprint } from '../src/core/verification.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { planJob } from '../src/ops/factory.ts';
import { policyAt, showVerification } from '../src/ops/verify.ts';
import { openStore } from '../src/storage/client.ts';
import { claimJob, getJob } from '../src/storage/jobs.ts';
import { latestRun, listRuns } from '../src/storage/verification.ts';
import { add, go, head, makePolicyRepo, SESSION, start, verify } from './drive.ts';
import { commitFile, gitIn, homePaths, removeLink, tempDir } from './helpers.ts';
import { store, clone, extra, policyWith, setBaselinePolicy, inBuild } from './verify-fixture.ts';

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
    // Under 30 s proves the 1 s timeout killed the 30 s child; the slack is for loaded CI runners,
    // where launching the four checks alone has taken over 20 s.
    expect(Date.now() - t0).toBeLessThan(25000);
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

describe('policyAt: the policy at a commit, remembered only per worktree and full commit id', () => {
  it('never answers for another repository, a moved ref, or a file that was absent', () => {
    const other = makePolicyRepo();
    extra.push(other.clone, other.bare);
    // Two repositories whose policies differ at their own tips.
    commitFile(
      other.clone,
      'factory.json',
      policyWith([{ id: 'other', command: 'node', args: ['-e', '0'] }]),
    );
    // Fixture repositories built in the same second share commit ids; make ours unique.
    const ours = commitFile(clone, 'unique.txt', `${String(Date.now())}-${String(Math.random())}`);
    const theirs = gitIn(other.clone, 'rev-parse', 'HEAD');
    expect(policyAt(clone, ours).commands.map((c) => c.id)).toEqual(['check']);
    expect(policyAt(other.clone, theirs).commands.map((c) => c.id)).toEqual(['other']);
    // The same commit id asked of a repository that does not have it is not answered from memory.
    expect(policyAt(other.clone, ours).commands).toEqual([]);
    // A ref name is never remembered: it moves.
    expect(policyAt(clone, 'HEAD').commands.map((c) => c.id)).toEqual(['check']);
    commitFile(
      clone,
      'factory.json',
      policyWith([{ id: 'moved', command: 'node', args: ['-e', '0'] }]),
    );
    expect(policyAt(clone, 'HEAD').commands.map((c) => c.id)).toEqual(['moved']);
    expect(policyAt(clone, ours).commands.map((c) => c.id)).toEqual(['check']);
    // A commit without factory.json reads as empty, and is read again each time.
    gitIn(clone, 'rm', '-q', 'factory.json');
    gitIn(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'drop policy');
    expect(policyAt(clone, gitIn(clone, 'rev-parse', 'HEAD')).commands).toEqual([]);
  });
});
