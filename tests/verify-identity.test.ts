/**
 * `orch verify`: run identity, ownership, and concurrency.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { installRoot } from '../src/core/paths.ts';
import { parsePolicy } from '../src/core/verification.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { planJob } from '../src/ops/factory.ts';
import { showVerification } from '../src/ops/verify.ts';
import { claimJob, getJob } from '../src/storage/jobs.ts';
import {
  type CheckResult,
  finishRun,
  latestRun,
  listRuns,
  recordCheck,
  runDetail,
  startRun,
} from '../src/storage/verification.ts';
import { add, CHECK_JS, go, head, SESSION, start, verify } from './drive.ts';
import { commitFile, gitIn, json, orch, orchAsync } from './helpers.ts';
import { store, clone, policyWith, setBaselinePolicy, inBuild } from './verify-fixture.ts';

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

  it('a superseded run that finishes late keeps its interrupted record; the newer run decides', () => {
    const c = start(store, clone);
    inBuild(c);
    // Run A starts (its process is still going, e.g. moved to the background by the Bash tool)...
    const a = startRun(store, c.id, {
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
    // ...and run B starts and finishes meanwhile, marking A interrupted.
    expect(verify(store, c).status).toBe('passed');
    const late: CheckResult = {
      status: 'failed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: 1,
      exitCode: 1,
      signal: null,
      outputPath: null,
      outputSha256: null,
      truncated: false,
      error: null,
    };
    const checkRow = a.checks[0]?.id ?? -1;
    expect(() => recordCheck(store, c.id, { token: c.token }, checkRow, late)).toThrow(
      /is interrupted, not running/,
    );
    expect(() => finishRun(store, c.id, { token: c.token }, a.run.id, 'failed')).toThrow(
      /is interrupted, not running/,
    );
    const runs = listRuns(store.db, c.id);
    expect(runs.map((r) => r.status)).toEqual(['passed', 'interrupted']);
    expect(runDetail(store.db, a.run.id)?.checks[0]?.status).toBe('pending');
    expect(showVerification(store, c.id)?.valid).toBe(true);
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
