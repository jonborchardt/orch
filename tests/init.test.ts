/**
 * `orch init` and `orch init --check`: writing a reviewed factory.json into a repository and
 * reporting whether the policy the factory trusts is committed. Real temporary repositories; the
 * trust-boundary test drives a real job so the baseline rule is exercised, not assumed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UsageError, ValidationError } from '../src/core/errors.ts';
import { canonicalPath } from '../src/core/paths.ts';
import { DEFAULT_RUNNER_CLAUDE_ARGS } from '../src/core/roles.ts';
import { parsePolicyText, policyFingerprint } from '../src/core/verification.ts';
import { describeRepo } from '../src/git/repo.ts';
import { startJob } from '../src/ops/factory.ts';
import { checkReadiness, gradedReadiness, initRepo, parseCommandFlag } from '../src/ops/init.ts';
import { worktreeOf } from '../src/ops/tree.ts';
import { effectivePolicy } from '../src/ops/verify.ts';
import type { Store } from '../src/storage/client.ts';
import { getJob } from '../src/storage/jobs.ts';
import { makePolicyRepo, POLICY, SESSION, start } from './drive.ts';
import {
  commitFile,
  ghShim,
  gitIn,
  json,
  makeRepo,
  makeRepoWithOrigin,
  NOOP_POLICY,
  orch,
  tempDir,
  tempStore,
} from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(origin?: string): string {
  const dir = makeRepo(origin);
  dirs.push(dir);
  return dir;
}

const NODE_OK = 'noop=node -e 0';
const commits = (dir: string) => gitIn(dir, 'rev-list', '--count', 'HEAD');
const files = (dir: string) => readdirSync(dir).filter((f) => f !== '.git');
/** Git reports long-form paths while a temp dir may be an 8.3 short name (CI runners): compare real paths. */
const samePath = (actual: string, expected: string) => {
  expect(canonicalPath(actual)).toBe(canonicalPath(expected));
};

describe('orch init: writing factory.json', () => {
  it('writes a valid policy from --command flags, commits nothing, and says what to do next', () => {
    const dir = repo();
    const before = commits(dir);
    const r = initRepo({ cwd: dir, commands: ['test=npm run test', 'build=npm run build'] });
    samePath(r.path, join(dir, 'factory.json'));
    expect(r.replaced).toBe(false);
    expect(r.checks).toEqual(['test: npm run test', 'build: npm run build']);
    const policy = parsePolicyText(readFileSync(r.path, 'utf8'));
    expect(policy.commands.map((c) => [c.id, c.command, c.args])).toEqual([
      ['test', 'npm', ['run', 'test']],
      ['build', 'npm', ['run', 'build']],
    ]);
    expect(r.next.join('\n')).toMatch(/git add factory.json.*git commit/);
    expect(r.next.join('\n')).toContain('orch init --check');
    expect(commits(dir)).toBe(before);
    expect(gitIn(dir, 'status', '--porcelain')).toBe('?? factory.json');
    expect(files(dir)).toEqual(['factory.json']); // no temp file left behind
  });

  it('requires the developer to name commands when nothing can be inferred', () => {
    const dir = repo();
    expect(() => initRepo({ cwd: dir })).toThrow(UsageError);
    expect(() => initRepo({ cwd: dir })).toThrow(/--command/);
    expect(files(dir)).toEqual([]);
  });

  it('suggests package.json scripts but writes them only with --from-package-json', () => {
    const dir = repo();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'x', lint: 'x', typecheck: 'x', check: 'x', build: 'x' } }),
    );
    expect(() => initRepo({ cwd: dir })).toThrow(/check: npm run check; build: npm run build/);
    expect(existsSync(join(dir, 'factory.json'))).toBe(false);
    const r = initRepo({ cwd: dir, fromPackageJson: true, commands: ['e2e=npx playwright test'] });
    expect(r.checks).toEqual([
      'check: npm run check',
      'build: npm run build',
      'e2e: npx playwright test',
    ]);
    // Without a `check` script every conventional script is proposed individually.
    const other = repo();
    writeFileSync(
      join(other, 'package.json'),
      JSON.stringify({ scripts: { test: 'x', lint: 'x' } }),
    );
    expect(initRepo({ cwd: other, fromPackageJson: true }).checks).toEqual([
      'test: npm run test',
      'lint: npm run lint',
    ]);
    // A package.json without scripts (or unparseable) infers nothing.
    const bare = repo();
    writeFileSync(join(bare, 'package.json'), '{not json');
    expect(() => initRepo({ cwd: bare, fromPackageJson: true })).toThrow(
      /No verification commands/,
    );
  });

  it('refuses outside a Git repository', () => {
    const dir = tempDir('orch-init-plain-');
    dirs.push(dir);
    expect(() => initRepo({ cwd: dir, commands: [NODE_OK] })).toThrow(ValidationError);
    expect(() => initRepo({ cwd: dir, commands: [NODE_OK] })).toThrow(
      /not inside a Git repository/,
    );
    expect(files(dir)).toEqual([]);
    const r = orch(tempDir('orch-init-home-'), dir, ['init', '--command', NODE_OK]);
    expect(r.code).toBe(1);
  });

  it('protects an existing factory.json unless --force is given', () => {
    const dir = repo();
    const custom =
      '{"verification":{"commands":[{"id":"mine","command":"node","args":["-e","0"]}]}}\n';
    writeFileSync(join(dir, 'factory.json'), custom);
    expect(() => initRepo({ cwd: dir, commands: [NODE_OK] })).toThrow(/already exists/);
    expect(readFileSync(join(dir, 'factory.json'), 'utf8')).toBe(custom);
    const r = initRepo({ cwd: dir, commands: [NODE_OK], force: true });
    expect(r.replaced).toBe(true);
    expect(parsePolicyText(readFileSync(r.path, 'utf8')).commands[0]?.id).toBe('noop');
  });

  it('rejects invalid commands before writing anything', () => {
    const dir = repo();
    expect(() => initRepo({ cwd: dir, commands: ['Bad Id=node -e 0'] })).toThrow(ValidationError);
    expect(() => initRepo({ cwd: dir, commands: ['x=./script.sh'] })).toThrow(/plain executable/);
    expect(() => initRepo({ cwd: dir, commands: ['x=node', 'x=node'] })).toThrow(/duplicate/);
    expect(() => initRepo({ cwd: dir, commands: ['nodash'] })).toThrow(UsageError);
    expect(() => initRepo({ cwd: dir, commands: ['=node'] })).toThrow(UsageError);
    expect(() => initRepo({ cwd: dir, commands: ['x='] })).toThrow(UsageError);
    expect(files(dir)).toEqual([]);
    // With --force the existing file survives a validation failure untouched.
    writeFileSync(join(dir, 'factory.json'), '{}\n');
    expect(() => initRepo({ cwd: dir, commands: ['x=a b'], force: true })).not.toThrow();
    expect(() => initRepo({ cwd: dir, commands: ['Bad=a'], force: true })).toThrow(ValidationError);
    expect(parsePolicyText(readFileSync(join(dir, 'factory.json'), 'utf8')).commands[0]?.id).toBe(
      'x',
    );
    expect(parseCommandFlag(' spaced =  npm   run  test ')).toEqual({
      id: 'spaced',
      command: 'npm',
      args: ['run', 'test'],
    });
  });

  it('is repeatable: --force rewrites byte-identical content and never touches history', () => {
    const dir = repo();
    const first = initRepo({ cwd: dir, commands: [NODE_OK] });
    const text = readFileSync(first.path, 'utf8');
    const before = commits(dir);
    initRepo({ cwd: dir, commands: [NODE_OK], force: true });
    initRepo({ cwd: dir, commands: [NODE_OK], force: true });
    expect(readFileSync(first.path, 'utf8')).toBe(text);
    expect(commits(dir)).toBe(before);
    expect(files(dir)).toEqual(['factory.json']);
  });

  it('works for repository paths containing spaces, via --repo and from inside', () => {
    const parent = tempDir('orch init space-');
    dirs.push(parent);
    const dir = join(parent, 'my repo');
    mkdirSync(dir);
    makeRepo(undefined, dir);
    const home = tempDir('orch-init-home-');
    dirs.push(home);
    const r = orch(home, tmpdir(), ['--json', 'init', '--repo', dir, '--command', NODE_OK]);
    expect(r.code).toBe(0);
    samePath(json<{ path: string }>(r).path, join(dir, 'factory.json'));
    const again = orch(home, dir, ['init', '--command', NODE_OK]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');
    expect(orch(home, dir, ['init', '--check']).out).toMatch(/^UNCOMMITTED/);
  });

  it('accepts Windows-style spellings of the repository path', () => {
    const dir = repo();
    const trailing = initRepo({ cwd: tmpdir(), repo: dir + sep, commands: [NODE_OK] });
    samePath(trailing.path, join(dir, 'factory.json'));
    if (process.platform === 'win32') {
      const flipped = dir.split('/').join('\\');
      const lower = flipped.charAt(0).toLowerCase() + flipped.slice(1);
      const r = checkReadiness(tmpdir(), lower);
      expect(r.status).toBe('uncommitted');
      samePath(r.path ?? '', join(dir, 'factory.json'));
      const forward = checkReadiness(tmpdir(), dir.split('\\').join('/'));
      expect(forward.status).toBe('uncommitted');
    }
  });

  it('CLI: help, unexpected arguments, human output', () => {
    const home = tempDir('orch-init-home-');
    dirs.push(home);
    const dir = repo();
    expect(orch(home, tmpdir(), ['init', '--help']).out).toContain('Usage: orch init');
    expect(orch(home, dir, ['init', 'extra']).code).toBe(2);
    const r = orch(home, dir, ['init', '--command', NODE_OK]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Wrote .*factory\.json for /);
    expect(r.out).toContain('1. Review factory.json');
  });
});

describe('orch init --check: readiness', () => {
  it('distinguishes no repository, missing, invalid, ignored, uncommitted, committed', () => {
    const plain = tempDir('orch-init-plain-');
    dirs.push(plain);
    expect(checkReadiness(plain)).toMatchObject({ status: 'no-git-repository', ready: false });

    const dir = repo();
    expect(checkReadiness(dir)).toMatchObject({ status: 'missing', ready: false });

    writeFileSync(join(dir, 'factory.json'), '{"verification":{"commands":[{"id":"x"}]}}');
    expect(checkReadiness(dir)).toMatchObject({ status: 'invalid', ready: false });
    expect(checkReadiness(dir).detail).toContain('command must be a plain executable');
    writeFileSync(join(dir, 'factory.json'), '{ nope');
    expect(checkReadiness(dir).detail).toContain('not JSON');

    initRepo({ cwd: dir, commands: [NODE_OK], force: true });
    expect(checkReadiness(dir)).toMatchObject({ status: 'uncommitted', ready: false });
    expect(checkReadiness(dir).next).toMatch(/git add factory.json/);

    writeFileSync(join(dir, '.gitignore'), 'factory.json\n');
    expect(checkReadiness(dir)).toMatchObject({ status: 'ignored', ready: false });
    rmSync(join(dir, '.gitignore'));

    gitIn(dir, 'add', 'factory.json');
    expect(checkReadiness(dir).status).toBe('uncommitted'); // staged is not committed
    gitIn(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'policy');
    const ready = checkReadiness(dir);
    expect(ready).toMatchObject({
      status: 'ready',
      ready: true,
      baseRef: 'main',
      checks: ['noop'],
    });
    expect(ready.detail).toContain('committed at main');

    // Editing the committed file makes it uncommitted again, even though HEAD has a policy.
    writeFileSync(
      join(dir, 'factory.json'),
      readFileSync(join(dir, 'factory.json'), 'utf8') + '\n',
    );
    expect(checkReadiness(dir).status).toBe('uncommitted');
  });

  it('reports a policy that is committed but not pushed when origin/<branch> is the baseline', () => {
    const { clone, bare } = makeRepoWithOrigin();
    dirs.push(clone, bare);
    expect(checkReadiness(clone)).toMatchObject({ status: 'ready', baseRef: 'origin/main' });
    commitFile(clone, 'factory.json', JSON.stringify(POLICY) + '\n', 'change policy');
    const r = checkReadiness(clone);
    expect(r).toMatchObject({ status: 'unpushed', ready: false, baseRef: 'origin/main' });
    expect(r.next).toBe('git push origin main');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    expect(checkReadiness(clone).status).toBe('ready');
  });

  it('reports an empty policy and executables missing from PATH', () => {
    const dir = repo();
    commitFile(dir, 'factory.json', '{"verification":{"commands":[]}}\n');
    expect(checkReadiness(dir)).toMatchObject({ status: 'unconfigured', ready: false });
    commitFile(
      dir,
      'factory.json',
      '{"verification":{"commands":[{"id":"a","command":"node"},{"id":"b","command":"definitely-not-a-tool-xyz"}]}}\n',
    );
    const r = checkReadiness(dir);
    expect(r).toMatchObject({ status: 'missing-tools', ready: false });
    expect(r.missingTools).toEqual(['definitely-not-a-tool-xyz']);
  });

  it('handles a repository with no commits and a --repo path, and sets the exit code', () => {
    const dir = tempDir('orch-init-unborn-');
    dirs.push(dir);
    gitIn(dir, 'init', '-q', '-b', 'main');
    initRepo({ cwd: dir, commands: [NODE_OK] });
    expect(checkReadiness(tmpdir(), dir)).toMatchObject({ status: 'uncommitted', ready: false });
    const home = tempDir('orch-init-home-');
    dirs.push(home);
    const r = orch(home, tmpdir(), ['--json', 'init', '--check', '--repo', dir]);
    expect(r.code).toBe(1);
    expect(json<{ status: string }>(r).status).toBe('uncommitted');
    const ok = repo();
    commitFile(ok, 'factory.json', JSON.stringify(POLICY) + '\n');
    expect(orch(home, ok, ['init', '--check']).code).toBe(0);
    expect(orch(home, ok, ['init', '--check']).out).toMatch(/^READY/);
  });
});

describe('orch init --check: readiness grade (advice, never the exit code)', () => {
  const home = () => {
    const h = tempDir('orch-init-home-');
    dirs.push(h);
    return h;
  };
  const gh = () => {
    const shim = ghShim('acme/alpha');
    dirs.push(shim.dir);
    return shim;
  };
  interface Graded {
    status: string;
    ready: boolean;
    grade: { letter: string; met: number; facts: Record<string, boolean | null> } | null;
  }

  it('grades a ready repository with a non-GitHub origin without running gh, and exits 0 at D', () => {
    const { clone, bare } = makeRepoWithOrigin('https://git.example.com/acme/alpha.git');
    dirs.push(clone, bare);
    const shim = gh();
    const r = orch(home(), tmpdir(), ['--json', 'init', '--check', '--repo', clone], shim.env);
    expect(r.code, r.err).toBe(0);
    expect(json<Graded>(r)).toMatchObject({
      ready: true,
      grade: {
        letter: 'D',
        met: 0,
        // NOOP_POLICY's only check is "noop": no test command.
        facts: { policyTest: false, requiredChecks: null, upToDate: null, protection: null },
      },
    });
    expect(shim.read().calls).toEqual([]);
    expect(checkReadiness(clone)).not.toHaveProperty('grade');
  });

  it('keeps exit 1 for a missing policy, graded with policyTest false', () => {
    const dir = repo();
    const r = orch(home(), dir, ['--json', 'init', '--check']);
    expect(r.code).toBe(1);
    expect(json<Graded>(r)).toMatchObject({
      status: 'missing',
      grade: { letter: 'D', facts: { policyTest: false } },
    });
    const plain = tempDir('orch-init-plain-');
    dirs.push(plain);
    expect(gradedReadiness(plain).grade).toBeNull();
  });

  it('prints the grade line and the advice for each unmet fact, from GitHub for a github.com origin', () => {
    const { clone, bare } = makeRepoWithOrigin();
    dirs.push(clone, bare);
    commitFile(clone, 'factory.json', JSON.stringify(POLICY) + '\n', 'test policy');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const shim = gh();
    shim.write({
      protection: { strict: false, contexts: ['ci'] },
      api: { 'repos/acme/alpha/branches/main': { protected: true } },
    });
    const r = orch(home(), clone, ['init', '--check'], shim.env);
    expect(r.code, r.err).toBe(0);
    const lines = r.out.split('\n');
    const at = lines.findIndex((l) => l.startsWith('grade'));
    expect(lines[at]).toBe('grade     B (3/4)');
    expect(lines.slice(at + 1).filter((l) => l.trim().startsWith('- '))).toEqual([
      expect.stringMatching(/up to date.*merge queue/),
    ]);
  });
});

describe('orch init --check: agent permissions (ticket 0200)', () => {
  const DEFAULT_TOOLS = DEFAULT_RUNNER_CLAUDE_ARGS.slice(3);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  interface Checked {
    ready: boolean;
    allowedTools: string[] | null;
    grade: { letter: string; uncovered: string[]; advice: string[] } | null;
  }
  /** A ready repository whose required check runs `pnpm`, a stub `pnpm` on PATH, and a home. */
  function pnpmRepo() {
    const { clone, bare } = makeRepoWithOrigin('https://git.example.com/acme/alpha.git');
    const bin = tempDir('orch-bin-');
    const home = tempDir('orch-init-home-');
    dirs.push(clone, bare, bin, home);
    writeFileSync(join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'), '');
    const policy = {
      verification: { commands: [{ id: 'test', command: 'pnpm', args: ['test'] }] },
    };
    commitFile(clone, 'factory.json', JSON.stringify(policy) + '\n', 'pnpm policy');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const env = { [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` };
    const check = (config?: object) => {
      if (config) writeFileSync(join(home, 'factory.json'), JSON.stringify(config));
      const r = orch(home, clone, ['--json', 'init', '--check'], env);
      expect(r.code, r.err).toBe(0);
      return json<Checked>(r);
    };
    return { clone, home, env, check, identity: describeRepo(clone).identity };
  }

  it('reports a pnpm check as not covered by the defaults, with the exact setting, never in the exit code', () => {
    const { clone, home, env, check, identity } = pnpmRepo();
    const r = check();
    expect(r.ready).toBe(true);
    expect(r.allowedTools).toEqual(DEFAULT_TOOLS);
    expect(r.grade?.uncovered).toEqual(['pnpm']);
    const advice = r.grade?.advice.at(-1) ?? '';
    for (const part of [
      '"Bash(pnpm *)"',
      'repoAllowedTools',
      identity,
      join(home, 'factory.json'),
    ]) {
      expect(advice).toContain(part);
    }
    const text = orch(home, clone, ['init', '--check'], env);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`allowed   ${DEFAULT_TOOLS.join(', ')}`);
    expect(text.out).toContain('uncovered pnpm');
  });

  it('closes the gap from extraAllowedTools, repoAllowedTools for this identity, or an override', () => {
    const { check, identity } = pnpmRepo();
    expect(check({ extraAllowedTools: ['Bash(pnpm *)'] }).grade?.uncovered).toEqual([]);
    const scoped = check({ repoAllowedTools: { [identity]: ['Bash(pnpm *)'] } });
    expect(scoped.grade?.uncovered).toEqual([]);
    expect(scoped.allowedTools).toEqual([...DEFAULT_TOOLS, 'Bash(pnpm *)']);
    const other = check({ repoAllowedTools: { 'github.com/someone/else': ['Bash(pnpm *)'] } });
    expect(other.grade?.uncovered).toEqual(['pnpm']);
    expect(other.allowedTools).toEqual(DEFAULT_TOOLS);
    const override = check({ runnerClaudeArgs: ['--allowedTools', 'Bash(pnpm *)'] });
    expect(override.grade?.uncovered).toEqual([]);
  });

  it('never takes permissions from a factory.json committed in the repository', () => {
    const { clone, home } = pnpmRepo();
    const granting = {
      extraAllowedTools: ['Bash(pnpm *)'],
      repoAllowedTools: { [describeRepo(clone).identity]: ['Bash(pnpm *)'] },
      verification: { commands: [{ id: 'test', command: 'pnpm', args: ['test'] }] },
    };
    commitFile(clone, 'factory.json', JSON.stringify(granting) + '\n', 'try to grant');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const r = orch(home, clone, ['--json', 'init', '--check']);
    expect(json<Checked>(r).allowedTools).toEqual(DEFAULT_TOOLS);
  });
});

describe('orch init: trust boundary', () => {
  it('a job that rewrites factory.json in its worktree does not change the policy the factory trusts', () => {
    const store = tempStore();
    const { clone, bare } = makePolicyRepo();
    dirs.push(clone, bare, store.home);
    try {
      const baseline = policyFingerprint(
        parsePolicyText(readFileSync(join(clone, 'factory.json'), 'utf8')),
      );
      const c = start(store, clone);
      // The builder "onboards" its own worktree with a weaker policy and commits it.
      const r = initRepo({ cwd: c.wt, commands: ['weak=node -e 0'], force: true });
      expect(r.replaced).toBe(true);
      gitIn(c.wt, 'add', 'factory.json');
      gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'weaken');
      const job = getJob(store.db, c.id);
      const wt = worktreeOf(job);
      if (!wt) throw new Error('job has no worktree');
      const eff = effectivePolicy(job, wt);
      expect(eff.source).toBe('baseline');
      expect(eff.fingerprint).toBe(baseline);
      expect(eff.policy.commands.map((x) => x.id)).toEqual(['check']);
      expect(eff.diff).toMatchObject({ changed: true, added: ['weak'], removed: ['check'] });
      expect(eff.diff?.weakened).toEqual(['check']);
      // The primary checkout was never written to or committed.
      expect(gitIn(clone, 'status', '--porcelain')).toBe('');
      expect(checkReadiness(clone).status).toBe('ready');
    } finally {
      store.cleanup();
    }
  });
});

describe('orch init --check: same baseline as a real job', () => {
  /** Start a job from `cwd` as `orch factory start` does and return the policy it trusts. */
  function trusted(store: Store, cwd: string) {
    const r = startJob(store, {
      title: 'Parity',
      description: 'Test request',
      session: SESSION,
      cwd,
    });
    const wt = worktreeOf(getJob(store.db, r.job.id));
    if (!wt) throw new Error('job has no worktree');
    return effectivePolicy(getJob(store.db, r.job.id), wt);
  }
  const fingerprintOf = (dir: string) =>
    policyFingerprint(parsePolicyText(readFileSync(join(dir, 'factory.json'), 'utf8')));

  it('without an origin, a committed policy is ready and is what the job reads, on any branch', () => {
    const store = tempStore();
    dirs.push(store.home);
    try {
      const dir = repo();
      commitFile(dir, 'factory.json', NOOP_POLICY);
      const main = checkReadiness(dir);
      expect(main).toMatchObject({ status: 'ready', baseRef: 'main' });
      const effMain = trusted(store, dir);
      expect(effMain.head).toBe(gitIn(dir, 'rev-parse', 'main'));
      expect(effMain.fingerprint).toBe(fingerprintOf(dir));

      gitIn(dir, 'checkout', '-q', '-b', 'feature');
      commitFile(dir, 'factory.json', JSON.stringify(POLICY) + '\n', 'stricter policy');
      const feature = checkReadiness(dir);
      expect(feature).toMatchObject({ status: 'ready', baseRef: 'feature' });
      const effFeature = trusted(store, dir);
      expect(effFeature.head).toBe(gitIn(dir, 'rev-parse', 'feature'));
      expect(effFeature.fingerprint).toBe(fingerprintOf(dir));
      expect(effFeature.fingerprint).not.toBe(effMain.fingerprint);
    } finally {
      store.cleanup();
    }
  });

  it('with an origin, the job reads origin/<branch>: a local unpushed policy is reported, not trusted', () => {
    const store = tempStore();
    dirs.push(store.home);
    try {
      const { clone, bare } = makeRepoWithOrigin(); // origin/main carries NOOP_POLICY
      dirs.push(clone, bare);
      const originFingerprint = fingerprintOf(clone);
      commitFile(clone, 'factory.json', JSON.stringify(POLICY) + '\n', 'local only');
      expect(checkReadiness(clone)).toMatchObject({ status: 'unpushed', baseRef: 'origin/main' });
      const eff = trusted(store, clone);
      expect(eff.head).toBe(gitIn(clone, 'rev-parse', 'origin/main'));
      expect(eff.fingerprint).toBe(originFingerprint);
      expect(eff.fingerprint).not.toBe(fingerprintOf(clone));

      gitIn(clone, 'push', '-q', 'origin', 'main');
      expect(checkReadiness(clone).status).toBe('ready');
      expect(trusted(store, clone).fingerprint).toBe(fingerprintOf(clone));
    } finally {
      store.cleanup();
    }
  });

  it('a pushed policy on one branch does not make another branch ready', () => {
    const store = tempStore();
    dirs.push(store.home);
    try {
      const { clone, bare } = makeRepoWithOrigin();
      dirs.push(clone, bare);
      gitIn(clone, 'checkout', '-q', '-b', 'release');
      gitIn(clone, 'rm', '-q', 'factory.json');
      gitIn(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'no policy here');
      gitIn(clone, 'push', '-q', '-u', 'origin', 'release');
      expect(checkReadiness(clone)).toMatchObject({ status: 'missing', ready: false });
      expect(trusted(store, clone).policy.commands).toEqual([]);
      // Re-adding it locally is still not what origin/release has.
      commitFile(clone, 'factory.json', NOOP_POLICY);
      expect(checkReadiness(clone)).toMatchObject({
        status: 'unpushed',
        baseRef: 'origin/release',
      });
      expect(trusted(store, clone).policy.commands).toEqual([]);
    } finally {
      store.cleanup();
    }
  });

  it('reports a detached HEAD instead of calling it ready, as no job can start there', () => {
    const store = tempStore();
    dirs.push(store.home);
    try {
      const dir = repo();
      commitFile(dir, 'factory.json', NOOP_POLICY);
      gitIn(dir, 'checkout', '-q', '--detach');
      const r = checkReadiness(dir);
      expect(r).toMatchObject({ status: 'no-base-branch', ready: false, baseRef: null });
      expect(r.detail).toContain('HEAD is detached');
      expect(() =>
        startJob(store, { title: 'x', description: 'x', session: SESSION, cwd: dir }),
      ).toThrow(/Base branch HEAD not found/);
    } finally {
      store.cleanup();
    }
  });
});
