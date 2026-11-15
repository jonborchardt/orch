/**
 * Sensitive-file detection and the verification-policy baseline: a job cannot weaken its own
 * checks by editing factory.json in its worktree, and summaries must name what changed.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildReport,
  classifyChanges,
  classifyPath,
  policyScriptPaths,
  scanDiff,
  sensitiveSummary,
} from '../src/core/sensitive.ts';
import { diffPolicy, parsePolicy } from '../src/core/verification.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { planJob } from '../src/ops/factory.ts';
import { pushBranch } from '../src/ops/github.ts';
import { claimJob, getJob } from '../src/storage/jobs.ts';
import { latestRun } from '../src/storage/verification.ts';
import {
  add,
  consolidated,
  go,
  makePolicyRepo,
  passRound,
  SESSION,
  start,
  toReview,
  verdict,
  verify,
} from './drive.ts';
import { commitFile, fixture, gitIn, type TempStore, tempStore } from './helpers.ts';

describe('classification (pure)', () => {
  it('labels test, config, CI, dependency, and policy paths across ecosystems', () => {
    const kinds = (p: string) => classifyPath(p)?.kind;
    expect(kinds('src/app.ts')).toBeUndefined();
    expect(kinds('src/app.test.ts')).toBe('tests');
    expect(kinds('src/__tests__/app.tsx')).toBe('tests');
    expect(kinds('tests/helpers.ts')).toBe('tests');
    expect(kinds('e2e/dashboard.spec.ts')).toBe('tests');
    expect(kinds('pkg/test_cli.py')).toBe('tests');
    expect(kinds('pkg/cli_test.go')).toBe('tests');
    expect(kinds('spec/models/user_spec.rb')).toBe('tests');
    expect(kinds('vitest.config.ts')).toBe('test-config');
    expect(kinds('web/tsconfig.json')).toBe('test-config');
    expect(kinds('pytest.ini')).toBe('test-config');
    expect(kinds('conftest.py')).toBe('test-config');
    expect(kinds('.github/workflows/ci.yml')).toBe('ci');
    expect(kinds('.gitlab-ci.yml')).toBe('ci');
    expect(kinds('package.json')).toBe('deps');
    expect(kinds('pyproject.toml')).toBe('deps');
    expect(kinds('go.mod')).toBe('deps');
    expect(kinds('Cargo.lock')).toBe('deps');
    expect(kinds('factory.json')).toBe('policy');
    expect(kinds('docs/factory.json')).toBeUndefined();
    expect(classifyChanges([{ path: 'a.test.ts', status: 'added' }])[0]?.why).toContain('evidence');
  });

  it('names the files policy commands run, relative to their cwd', () => {
    const paths = policyScriptPaths([
      { command: 'node', args: ['check.js'], cwd: '.' },
      { command: 'bash', args: ['scripts/verify.sh', '--fast'], cwd: '.' },
      { command: 'npx', args: ['vitest', 'run', '--config=vitest.ci.ts'], cwd: 'web' },
      { command: 'node', args: ['..\\..\\outside.js', '.\\tools\\lint.mjs'], cwd: 'pkg' },
    ]);
    expect(paths).toEqual(
      expect.arrayContaining([
        'check.js',
        'scripts/verify.sh',
        'web/vitest.ci.ts',
        'pkg/tools/lint.mjs',
      ]),
    );
    expect(paths.some((p) => p.includes('outside.js'))).toBe(false);
    expect(paths).not.toContain('--fast');
    // Only changed paths are labelled; a policy script wins over its ordinary kind.
    const labelled = classifyChanges(
      [
        { path: 'scripts/verify.sh', status: 'modified' },
        { path: 'web/vitest.ci.ts', status: 'modified' },
        { path: 'src/app.ts', status: 'modified' },
      ],
      paths,
    );
    expect(labelled.map((x) => [x.path, x.kind])).toEqual([
      ['scripts/verify.sh', 'policy'],
      ['web/vitest.ci.ts', 'policy'],
    ]);
    const report = buildReport(
      [{ path: 'scripts/verify.sh', status: 'modified' }],
      scanDiff(''),
      null,
      false,
      paths,
    );
    expect(report.changes.map((x) => x.kind)).toEqual(['policy']);
    expect(report.needsReview).toBe(true);
    // Without the policy's paths the same edit is an ordinary source change.
    expect(
      buildReport([{ path: 'scripts/verify.sh', status: 'modified' }], scanDiff(''), null, false)
        .needsReview,
    ).toBe(false);
  });

  it('finds disabled, focused, commented-out, and removed tests in a diff', () => {
    const diff = [
      'diff --git a/src/a.test.ts b/src/a.test.ts',
      '--- a/src/a.test.ts',
      '+++ b/src/a.test.ts',
      '@@',
      "-  it('old one', () => {});",
      "-  it('old two', () => {});",
      "+  it.skip('old one', () => {});",
      "+  // it('old two', () => {});",
      "+  describe.only('focus', () => {});",
      'diff --git a/tests/test_x.py b/tests/test_x.py',
      '--- a/tests/test_x.py',
      '+++ b/tests/test_x.py',
      '+@pytest.mark.skip(reason="later")',
      '+def test_new():',
      '+    pass',
    ].join('\n');
    const scan = scanDiff(diff);
    expect(scan.disabled.map((d) => d.path)).toEqual([
      'src/a.test.ts',
      'src/a.test.ts',
      'src/a.test.ts',
      'tests/test_x.py',
    ]);
    expect(scan.removedTests).toEqual([{ path: 'src/a.test.ts', removed: 2, added: 0 }]);
    expect(scanDiff('')).toEqual({ disabled: [], removedTests: [] });
  });

  it('compares policies: added, removed, modified, and weakened checks', () => {
    const base = parsePolicy({
      verification: {
        commands: [
          { id: 'test', command: 'npm', args: ['test'] },
          { id: 'lint', command: 'npm', args: ['run', 'lint'] },
          { id: 'opt', command: 'npm', args: ['run', 'opt'], required: false },
        ],
      },
    });
    const candidate = parsePolicy({
      verification: {
        commands: [
          { id: 'test', command: 'npm', args: ['test', '--', '--passWithNoTests'] },
          { id: 'lint', command: 'npm', args: ['run', 'lint'], required: false },
          { id: 'build', command: 'npm', args: ['run', 'build'] },
        ],
      },
    });
    const d = diffPolicy(base, candidate);
    expect(d).toEqual({
      changed: true,
      added: ['build'],
      removed: ['opt'],
      modified: ['test', 'lint'],
      weakened: ['test', 'lint'],
    });
    expect(diffPolicy(base, base).changed).toBe(false);
    expect(diffPolicy(base, parsePolicy({ verification: { commands: [] } })).weakened).toEqual([
      'test',
      'lint',
    ]);
  });

  it('only plainly added tests are quiet; everything else needs review', () => {
    const quiet = buildReport(
      [{ path: 'src/a.test.ts', status: 'added' }],
      scanDiff(''),
      null,
      false,
    );
    expect(quiet.needsReview).toBe(false);
    expect(quiet.authorization).toBe('not-needed');
    const removed = buildReport(
      [{ path: 'src/a.test.ts', status: 'deleted' }],
      scanDiff(''),
      null,
      false,
    );
    expect(removed.needsReview).toBe(true);
    const ci = buildReport(
      [{ path: '.github/workflows/ci.yml', status: 'modified' }],
      scanDiff(''),
      null,
      false,
    );
    expect(ci.needsReview).toBe(true);
    const policy = buildReport(
      [{ path: 'factory.json', status: 'modified' }],
      scanDiff(''),
      { changed: true, added: [], removed: ['lint'], modified: [], weakened: ['lint'] },
      false,
    );
    expect(policy.authorization).toBe('required');
    expect(sensitiveSummary(policy).join('\n')).toContain('weakened: lint');
    expect(sensitiveSummary(policy).join('\n')).toContain('REQUIRED');
    const authorized = buildReport([], scanDiff(''), null, true);
    expect(authorized.authorization).toBe('authorized');
    expect(authorized.needsReview).toBe(false);
  });
});

describe('sensitive changes in a real job', () => {
  let store: TempStore;
  let clone: string;
  let bare: string;
  beforeEach(() => {
    store = tempStore();
    ({ clone, bare } = makePolicyRepo());
  });
  afterEach(() => {
    store.cleanup();
    for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
  });

  it('reports added, modified, and removed tests, CI, dependency, and policy edits from the diff', () => {
    commitFile(clone, 'src/old.test.ts', "it('keeps', () => {});\nit('goes', () => {});\n");
    commitFile(clone, '.github/workflows/ci.yml', 'on: push\n');
    commitFile(clone, 'package.json', '{"scripts":{"test":"vitest run"}}\n');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const c = start(store, clone);
    const quiet = (() => {
      commitFile(c.wt, 'src/new.test.ts', "it('new', () => {});\n");
      return planJob(store, c.id).sensitive;
    })();
    expect(quiet?.changes).toEqual([
      {
        path: 'src/new.test.ts',
        status: 'added',
        kind: 'tests',
        why: expect.any(String) as string,
      },
    ]);
    expect(quiet?.needsReview).toBe(false);

    commitFile(c.wt, 'src/old.test.ts', "it('keeps', () => {});\nit.skip('goes', () => {});\n");
    commitFile(c.wt, '.github/workflows/ci.yml', 'on: push\njobs: {}\n');
    commitFile(c.wt, 'package.json', '{"scripts":{"test":"vitest run --passWithNoTests"}}\n');
    gitIn(c.wt, 'rm', '-q', 'check.js');
    gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'rm');
    const s = planJob(store, c.id).sensitive;
    expect(s?.needsReview).toBe(true);
    expect(s?.changes.map((x) => [x.path, x.status, x.kind])).toEqual([
      ['.github/workflows/ci.yml', 'modified', 'ci'],
      // The policy runs `node check.js`: deleting the script it runs is a policy change too.
      ['check.js', 'deleted', 'policy'],
      ['package.json', 'modified', 'deps'],
      ['src/new.test.ts', 'added', 'tests'],
      ['src/old.test.ts', 'modified', 'tests'],
    ]);
    expect(s?.scan.disabled).toEqual([
      { path: 'src/old.test.ts', line: "it.skip('goes', () => {});" },
    ]);
    expect(s?.policy).toBeNull();
    expect(planJob(store, c.id).reason).toContain('Sensitive changes need explicit review');
  });

  it('a job cannot weaken its own checks: the baseline keeps running and approval is refused', () => {
    const c = start(store, clone);
    toReview(store, c);
    // The builder drops the only required check and adds a no-op in its place.
    go(store, c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    add(store, c, 'round-1/consolidated.md', consolidated(store, c));
    go(store, c, 'complete'); // approve
    expect(getJob(store.db, c.id).stage).toBe('approve');
    go(store, c, 'start');
    commitFile(
      c.wt,
      'factory.json',
      JSON.stringify({
        verification: { commands: [{ id: 'noop', command: 'node', args: ['-e', '0'] }] },
      }),
    );
    commitFile(c.wt, 'marker.txt', 'BREAK\n');
    const r = verify(store, c);
    expect(r.status).toBe('failed'); // the baseline `check` still runs and still fails
    expect(r.checks.map((x) => x.checkId)).toEqual(['check']);
    expect(r.policy.authorization).toBe('required');
    const s = planJob(store, c.id).sensitive;
    expect(s?.policy).toEqual({
      changed: true,
      added: ['noop'],
      removed: ['check'],
      modified: [],
      weakened: ['check'],
    });
    expect(s?.changes.some((x) => x.kind === 'policy')).toBe(true);
    commitFile(c.wt, 'marker.txt', 'fine\n');
    expect(verify(store, c).status).toBe('passed');
    add(store, c, 'decision.md');
    expect(() => go(store, c, 'complete')).toThrow(/changes the verification policy/);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/pr stage only/);
  });

  it('reordering the checks changes what a run proves, so it counts as a policy change', () => {
    const two = makePolicyRepo('https://github.com/acme/two.git', {
      verification: {
        commands: [
          { id: 'check', command: 'node', args: ['check.js'] },
          { id: 'other', command: 'node', args: ['-e', '0'] },
        ],
      },
    });
    try {
      const c = start(store, two.clone);
      commitFile(
        c.wt,
        'factory.json',
        JSON.stringify({
          verification: {
            commands: [
              { id: 'other', command: 'node', args: ['-e', '0'] },
              { id: 'check', command: 'node', args: ['check.js'] },
            ],
          },
        }),
      );
      const plan = planJob(store, c.id);
      expect(plan.verification?.policy.authorization).toBe('required');
      expect(plan.sensitive?.authorization).toBe('required');
      expect(plan.sensitive?.policy).toMatchObject({ changed: true, added: [], removed: [] });
    } finally {
      for (const d of [two.clone, two.bare]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('a human accepts a stronger policy; the job then runs it and can be approved', () => {
    const c = start(store, clone);
    toReview(store, c);
    passRound(store, c);
    go(store, c, 'start');
    commitFile(
      c.wt,
      'factory.json',
      JSON.stringify({
        verification: {
          commands: [
            { id: 'check', command: 'node', args: ['check.js'] },
            { id: 'types', command: 'node', args: ['-e', '0'] },
          ],
        },
      }),
    );
    verify(store, c);
    add(store, c, 'decision.md');
    expect(() => go(store, c, 'complete')).toThrow(/A human must accept it/);
    go(store, c, 'escalate', 'verification policy needs human acceptance');
    dashboardAction(store, c.id, { action: 'accept-policy' });
    const job = getJob(store.db, c.id);
    expect(job.policy?.commands.map((x) => x.id)).toEqual(['check', 'types']);
    dashboardAction(store, c.id, { action: 'approve', to: 'approve' });
    const token = claimJob(store, c.id, { session: SESSION }).token;
    const c2 = { ...c, token };
    go(store, c2, 'start');
    expect(planJob(store, c.id).verification?.policy.authorization).toBe('authorized');
    expect(planJob(store, c.id).verification?.valid).toBe(false); // the old run used one check
    expect(verify(store, c2).checks.map((x) => x.checkId)).toEqual(['check', 'types']);
    expect(latestRun(store.db, c.id)?.run.policySource).toBe('authorized');
    expect(go(store, c2, 'complete').stage).toBe('pr');
    // Editing the policy again after acceptance reopens the question.
    commitFile(c.wt, 'factory.json', JSON.stringify({ verification: { commands: [] } }));
    expect(planJob(store, c.id).verification?.policy.authorization).toBe('required');
  });

  it('rewriting a script the policy runs is labelled: a no-op check.js cannot pass unnoticed', () => {
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'start');
    // The product breaks (the real check would fail) and the check is neutralised in one job.
    commitFile(c.wt, 'marker.txt', 'BREAK\n', 'break the product');
    commitFile(c.wt, 'check.js', "console.log('OK');\n", 'neutralise the check');
    // Verification still passes: the command is the baseline's, the file it runs is the job's.
    expect(verify(store, c).status).toBe('passed');
    const s = planJob(store, c.id).sensitive;
    expect(s?.changes).toEqual([
      expect.objectContaining({ path: 'check.js', kind: 'policy', status: 'modified' }),
    ]);
    expect(s?.needsReview).toBe(true);
    // The existing acknowledgement rule applies: the consolidation must name it.
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    const silent = fixture('round-1/consolidated.md').replace(
      '\nBLOCKING:',
      '\n## Sensitive changes\n\nNone\n\nBLOCKING:',
    );
    expect(() => add(store, c, 'round-1/consolidated.md', silent)).toThrow(
      /does not mention check.js/,
    );
    expect(add(store, c, 'round-1/consolidated.md', consolidated(store, c)).marker).toBe('0');
  });

  it('consolidated.md and pr.md must name every sensitive path', () => {
    commitFile(clone, 'src/old.test.ts', "it('old', () => {});\n");
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const c = start(store, clone);
    toReview(store, c);
    commitFile(c.wt, 'src/export.test.ts', "it('x', () => {});\n");
    gitIn(c.wt, 'rm', '-q', 'src/old.test.ts');
    gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'rm old test');
    go(store, c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    expect(() => add(store, c, 'round-1/consolidated.md')).toThrow(
      /needs a "Sensitive changes" section/,
    );
    const partial = fixture('round-1/consolidated.md').replace(
      '\nBLOCKING:',
      '\n## Sensitive changes\n\n- src/export.test.ts\n\nBLOCKING:',
    );
    expect(() => add(store, c, 'round-1/consolidated.md', partial)).toThrow(
      /does not mention src\/old.test.ts/,
    );
    expect(add(store, c, 'round-1/consolidated.md', consolidated(store, c)).marker).toBe('0');
  });
});
