import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jobArtifactDir, packageInfo } from '../src/core/paths.ts';
import {
  fixture,
  gitIn,
  homePaths,
  json,
  makeRepo,
  orch,
  orchAsync,
  tempDir,
  writeArtifact,
} from './helpers.ts';

let home: string;
let repoA: string;
let repoB: string;
const dirs: string[] = [];

beforeAll(() => {
  home = tempDir('orch-cli-home-');
  repoA = makeRepo('git@github.com:acme/alpha.git');
  repoB = makeRepo('https://github.com/acme/beta');
  dirs.push(home, repoA, repoB);
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Summary {
  jobId: string;
  stage: string;
  status: string;
  revision: number;
  token?: string;
  next: { stage: string; status: string; requiredArtifacts: string[] };
  job: { repo: string; baseBranch: string; ownerSession: string | null };
}

describe('orch CLI: basics', () => {
  it('--version, --help, usage errors', () => {
    expect(orch(home, tmpdir(), ['--version']).out.trim()).toBe(packageInfo().version);
    const help = orch(home, tmpdir(), ['--help']).out;
    expect(help).toContain('Usage: orch');
    // The normal path comes first, in order, then primary commands, then the low-level group.
    const workflow = [
      'Typical workflow:',
      '  orch init --check ',
      '  /factory <request> ',
      '  orch factory list ',
      '  orch factory status <id> ',
      '  orch ui ',
      'Commands:',
      '  factory <subcommand> ',
      'Low-level commands (used internally and by generated plans):',
      '  job <subcommand> ',
      'Options:',
    ].map((s) => help.indexOf(s));
    expect(workflow.every((i) => i >= 0)).toBe(true);
    expect(workflow).toEqual([...workflow].sort((a, b) => a - b));
    expect(help).toMatch(/\/factory <request> +In Claude Code \(a skill, not an orch command\)/);
    expect(help).toMatch(/ {2}factory <subcommand> +The primary interface/);
    for (const cmd of ['doctor', 'init', 'install', 'ui']) {
      const at = help.indexOf(`\n  ${cmd} `);
      expect(at).toBeGreaterThan(help.indexOf('Commands:'));
      expect(at).toBeLessThan(help.indexOf('Low-level commands'));
    }
    for (const cmd of ['job', 'worktree', 'checkout', 'gh', 'verify']) {
      expect(help.indexOf(`\n  ${cmd} `)).toBeGreaterThan(help.indexOf('Low-level commands'));
      expect(help.indexOf(`\n  ${cmd} `)).toBeLessThan(help.indexOf('Options:'));
    }
    expect(help).toContain('  -h, --help             Show this help');
    expect(help).toContain('  -v, --version          Show version');
    expect(help).toContain('--json             Machine-readable output');
    expect(help).toContain('orch is a one-shot CLI');
    expect(orch(home, tmpdir(), ['gh', '--help']).out).toContain(
      'recorded on the job when --token is given',
    );
    expect(orch(home, tmpdir(), []).code).toBe(2);
    const bogus = orch(home, tmpdir(), ['bogus']);
    expect(bogus.code).toBe(2);
    expect(bogus.err).toContain('Unknown command: bogus');
    expect(orch(home, tmpdir(), ['job', 'bogus']).code).toBe(2);
    expect(orch(home, tmpdir(), ['job', 'create']).err).toContain('Missing required --title');
    expect(orch(home, tmpdir(), ['--nope']).code).toBe(2);
    // A parse failure under --json is still a JSON error, like every other failure.
    const unknown = orch(home, tmpdir(), ['--json', '--nope']);
    expect(unknown.code).toBe(2);
    expect((JSON.parse(unknown.err) as { error: { type: string } }).error.type).toBe('UsageError');
    // --max-rounds 0 would escalate on the first review round; both entry points refuse it.
    expect(
      orch(home, repoA, [
        'job',
        'create',
        '--description',
        'd',
        '--title',
        't',
        '--max-rounds',
        '0',
      ]).err,
    ).toContain('--max-rounds must be an integer of at least 1');
    // A job needs a non-blank description; refused before anything is written.
    for (const blank of [[], ['--description', '   ']]) {
      const r = orch(home, repoA, ['job', 'create', '--title', 'no-desc', ...blank]);
      expect(r.code, r.err).toBe(2);
      expect(r.err).toContain('--description');
    }
    const listed = json<{ title: string }[]>(orch(home, tmpdir(), ['--json', 'job', 'list']));
    expect(listed.filter((j) => j.title === 'no-desc')).toEqual([]);
  });

  it('doctor runs outside a repository and reports the override home', () => {
    const r = orch(home, tmpdir(), ['doctor']);
    expect(r.out).toContain('Node.js');
    expect(r.out).toContain(home);
    expect(r.out).toContain('not inside a Git repository');
    const j = orch(home, tmpdir(), ['--json', 'doctor']);
    expect(Array.isArray(json(j))).toBe(true);
  });

  it('errors are JSON on stderr with --json and keep their exit codes', () => {
    const r = orch(home, tmpdir(), ['--json', 'job', 'show', 'job-nope']);
    expect(r.code).toBe(3);
    expect(r.out).toBe('');
    const err = JSON.parse(r.err) as { error: { type: string; exitCode: number } };
    expect(err.error.type).toBe('NotFoundError');
    expect(err.error.exitCode).toBe(3);
    expect(orch(home, tmpdir(), ['job', 'show', 'job-nope']).err).toMatch(/^NotFoundError:/);
  });

  it('job create needs a repository unless --repo is given', () => {
    const r = orch(home, tmpdir(), ['job', 'create', '--description', 'd', '--title', 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not inside a Git repository');
  });
});

describe('orch CLI: jobs across repositories', () => {
  let a: Summary;
  let b: Summary;

  it('creates jobs from two repositories into one shared store', () => {
    a = json<Summary>(
      orch(home, repoA, [
        '--json',
        'job',
        'create',
        '--description',
        'd',
        '--title',
        'Alpha feature',
      ]),
    );
    b = json<Summary>(
      orch(home, tmpdir(), [
        '--json',
        'job',
        'create',
        '--description',
        'Beta request',
        '--title',
        'Beta fix',
        '--repo',
        repoB,
        '--issue',
        '#12',
        '--base',
        'develop',
      ]),
    );
    expect(a.job.repo).toBe('github.com/acme/alpha');
    expect(a.job.baseBranch).toBe('main');
    expect(b.job.repo).toBe('github.com/acme/beta');
    expect(b.job.baseBranch).toBe('develop');
    expect(a.next).toEqual({ stage: 'spec', status: 'pending', requiredArtifacts: ['spec.md'] });
  });

  it('lists both from an unrelated directory, filtered by repo path or identity', () => {
    const all = json<{ id: string }[]>(orch(home, tmpdir(), ['--json', 'job', 'list']));
    expect(all.map((j) => j.id).sort()).toEqual([a.jobId, b.jobId].sort());
    const byPath = json<{ id: string }[]>(
      orch(home, tmpdir(), ['--json', 'job', 'list', '--repo', repoA]),
    );
    expect(byPath.map((j) => j.id)).toEqual([a.jobId]);
    const byId = json<{ id: string }[]>(
      orch(home, tmpdir(), ['--json', 'job', 'list', '--repo', 'github.com/acme/beta']),
    );
    expect(byId.map((j) => j.id)).toEqual([b.jobId]);
    const human = orch(home, tmpdir(), ['job', 'list']);
    expect(human.out).toContain('Alpha feature');
    expect(human.out).toContain('Beta fix');
    expect(orch(home, tmpdir(), ['job', 'list', '--status', 'nope']).code).toBe(2);
  });

  it('claim, transition, artifact, review, pr, show, events through the CLI', () => {
    const claim = json<Summary>(
      orch(home, repoB, ['--json', 'job', 'claim', a.jobId, '--session', 'vscode-1']),
    );
    const token = claim.token ?? '';
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(claim.job.ownerSession).toBe('vscode-1');

    // Token via environment, from a directory unrelated to the job's repository.
    const env = { ORCH_TOKEN: token };
    expect(orch(home, tmpdir(), ['job', 'transition', a.jobId, 'start'], env).code).toBe(0);
    const noArtifact = orch(home, tmpdir(), ['job', 'transition', a.jobId, 'complete'], env);
    expect(noArtifact.code).toBe(1);
    expect(noArtifact.err).toContain('missing required artifact spec.md');

    writeArtifact(jobArtifactDir(a.jobId, homePaths(home)), 'spec.md');
    const added = json<Summary & { artifact: { path: string } }>(
      orch(home, tmpdir(), ['--json', 'job', 'artifact', 'add', a.jobId, 'spec.md'], env),
    );
    expect(added.artifact.path).toBe('spec.md');

    // The spec challenger gates the spec: no challenge, or a CHANGES, refuses completion, and
    // escalating does not open a way around it.
    const dir = jobArtifactDir(a.jobId, homePaths(home));
    const complete = () => orch(home, tmpdir(), ['job', 'transition', a.jobId, 'complete'], env);
    const unchallenged = complete();
    expect(unchallenged.code).toBe(1);
    expect(unchallenged.err).toContain('factory-spec-challenger');
    writeArtifact(dir, 'spec-review-1.md', fixture('spec-review-1.md', 'CHANGES'));
    const add = (rel: string, ...more: string[]) =>
      orch(home, tmpdir(), ['job', 'artifact', 'add', a.jobId, rel, ...more], env);
    expect(add('spec-review-1.md').code).toBe(0);
    const changes = complete();
    expect(changes.code).toBe(1);
    expect(changes.err).toContain('spec-review-1.md from factory-spec-challenger says CHANGES');
    const escalated = orch(home, tmpdir(), ['job', 'transition', a.jobId, 'escalate'], env);
    expect(escalated.code).toBe(0);
    for (const to of ['build', 'review']) {
      const skip = orch(home, tmpdir(), [
        'job',
        'resume',
        a.jobId,
        '--session',
        'vscode-1',
        '--to',
        to,
      ]);
      expect(skip.code, to).toBe(1);
      expect(skip.err).toContain('factory-spec-challenger');
    }
    const blocked = json<{ job: { stage: string } }>(
      orch(home, tmpdir(), ['--json', 'job', 'show', a.jobId]),
    );
    expect(blocked.job.stage).toBe('needs-human');
    const back = json<Summary>(
      orch(home, tmpdir(), ['--json', 'job', 'resume', a.jobId, '--session', 'vscode-1']),
    );
    expect(back.stage).toBe('spec');
    env.ORCH_TOKEN = back.token ?? '';
    expect(orch(home, tmpdir(), ['job', 'transition', a.jobId, 'start'], env).code).toBe(0);
    writeArtifact(dir, 'spec.md', fixture('spec.md') + '\nRevised.\n');
    expect(add('spec.md', '--replace').code).toBe(0);
    writeArtifact(dir, 'spec-review-2.md');
    expect(add('spec-review-2.md').code).toBe(0);
    const done = json<Summary>(
      orch(home, tmpdir(), ['--json', 'job', 'transition', a.jobId, 'complete'], env),
    );
    expect(done.stage).toBe('build');
    expect(done.next.requiredArtifacts).toEqual(['build.md']);

    // Wrong token and competing claim are ownership errors (exit 4).
    const stale = orch(home, tmpdir(), ['job', 'transition', a.jobId, 'start', '--token', 'bad']);
    expect(stale.code).toBe(4);
    const competing = orch(home, tmpdir(), ['job', 'claim', a.jobId, '--session', 'vscode-2']);
    expect(competing.code).toBe(4);
    expect(competing.err).toContain('owned by session vscode-1');

    const show = orch(home, tmpdir(), ['job', 'show', a.jobId]);
    expect(show.code).toBe(0);
    expect(show.out).toContain('Alpha feature');
    expect(show.out).toContain('spec.md');
    const events = json<{ type: string }[]>(
      orch(home, tmpdir(), ['--json', 'job', 'events', a.jobId]),
    );
    expect(events.map((e) => e.type)).toEqual([
      'job.created',
      'models.drawn',
      'job.claimed',
      'stage.started',
      'artifact.registered',
      'artifact.registered',
      'job.blocked',
      // The two refused resumes claimed (renewed) but changed nothing else.
      'job.claimed',
      'job.claimed',
      'job.claimed',
      'job.resumed',
      'stage.started',
      'artifact.replaced',
      'artifact.registered',
      'stage.completed',
    ]);

    const released = json<Summary>(
      orch(home, tmpdir(), ['--json', 'job', 'release', a.jobId], env),
    );
    expect(released.job.ownerSession).toBeNull();
  });

  it('resume adopts a job whose owner went away', () => {
    const claim = json<Summary>(
      orch(home, repoA, ['--json', 'job', 'claim', b.jobId, '--session', 'old', '--lease', '0']),
    );
    orch(home, repoA, ['job', 'transition', b.jobId, 'start', '--token', claim.token ?? '']);
    const resumed = json<Summary>(
      orch(home, tmpdir(), ['--json', 'job', 'resume', b.jobId, '--session', 'new']),
    );
    expect(resumed.job.ownerSession).toBe('new');
    expect(resumed.status).toBe('pending');
    const old = orch(home, tmpdir(), [
      'job',
      'transition',
      b.jobId,
      'start',
      '--token',
      claim.token ?? '',
    ]);
    expect(old.code).toBe(4);
  });

  it('job repo re-points a job after its checkout gains an origin, same clone only', () => {
    const local = makeRepo();
    dirs.push(local);
    const c = json<Summary>(
      orch(home, local, ['--json', 'job', 'create', '--description', 'd', '--title', 'Local']),
    );
    expect(c.job.repo).toBe(local.split(/[\\/]/).pop()?.toLowerCase());
    const claim = json<Summary>(
      orch(home, tmpdir(), ['--json', 'job', 'claim', c.jobId, '--session', 's']),
    );
    const env = { ORCH_TOKEN: claim.token ?? '' };
    gitIn(local, 'remote', 'add', 'origin', 'https://github.com/acme/local.git');
    const other = orch(home, tmpdir(), ['job', 'repo', c.jobId, '--repo', repoA], env);
    expect(other.code).toBe(1);
    expect(other.err).toContain('belongs to');
    const moved = json<Summary>(orch(home, tmpdir(), ['--json', 'job', 'repo', c.jobId], env));
    expect(moved.job.repo).toBe('github.com/acme/local');
    const events = json<{ type: string }[]>(
      orch(home, tmpdir(), ['--json', 'job', 'events', c.jobId]),
    );
    expect(events.map((e) => e.type)).toContain('repo.repointed');
  });
});

describe('orch CLI: concurrency', () => {
  it('parallel creates all succeed with distinct ids', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        orchAsync(home, repoA, [
          '--json',
          'job',
          'create',
          '--description',
          'd',
          '--title',
          `par-${String(i)}`,
        ]),
      ),
    );
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0]);
    const ids = new Set(results.map((r) => json<Summary>(r).jobId));
    expect(ids.size).toBe(6);
  });

  it('parallel competing claims: exactly one wins', async () => {
    const job = json<Summary>(
      orch(home, repoA, ['--json', 'job', 'create', '--description', 'd', '--title', 'race']),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        orchAsync(home, repoA, ['--json', 'job', 'claim', job.jobId, '--session', `s${String(i)}`]),
      ),
    );
    const codes = results.map((r) => r.code).sort();
    expect(codes).toEqual([0, 4, 4, 4, 4]);
  });
});
