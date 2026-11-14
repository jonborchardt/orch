/**
 * Repository identity: a job stays bound to its own local repository (checkout plus linked
 * worktrees) when `origin` is added, removed, or re-pointed, while two unrelated repositories are
 * never conflated and recovery still honours leases and worktree ownership.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { resumeFactoryJob, startJob } from '../src/ops/factory.ts';
import { findJobs, jobCheckout, sameLocalRepo } from '../src/ops/repo.ts';
import { showVerification } from '../src/ops/verify.ts';
import { adoptWorktree, createWorktree, integrateBase, repointRepo } from '../src/ops/worktree.ts';
import { listArtifacts } from '../src/storage/artifacts.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob } from '../src/storage/jobs.ts';
import { add, go, SESSION, verify } from './drive.ts';
import {
  commitFile,
  gitIn,
  json,
  makeRepo,
  makeRepoWithOrigin,
  NOOP_POLICY,
  orch,
  tempDir,
  type TempStore,
  tempStore,
} from './helpers.ts';

let store: TempStore;
const dirs: string[] = [];

/** A repository without any remote, carrying a verification policy so gates can pass. */
function localRepo(dir = tempDir('orch-local-')): string {
  mkdirSync(dir, { recursive: true });
  const r = makeRepo(undefined, dir);
  commitFile(r, 'factory.json', NOOP_POLICY);
  dirs.push(r);
  return r;
}

function start(cwd: string, title = 'Local job') {
  const r = startJob(store, { title, session: SESSION, cwd });
  return { id: r.job.id, token: r.token, dir: r.plan.artifactDir, wt: r.job.worktreePath ?? '' };
}

const events = (id: string) => listEvents(store.db, id).map((e) => e.type);

beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('repository identity follows the local repository, not the remote', () => {
  it('a repository without origin is identified by its directory name and resumes', () => {
    const local = localRepo();
    const c = start(local);
    expect(getJob(store.db, c.id).repo).toBe(basename(local).toLowerCase());
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    expect(r.plan.step).toBe('run-stage');
    expect(r.job.worktreePath).toBe(c.wt);
  });

  it('origin added after creation: resume recovers the same job and refreshes its identity', () => {
    const local = localRepo();
    const c = start(local);
    gitIn(local, 'remote', 'add', 'origin', 'https://github.com/acme/local.git');
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    const job = getJob(store.db, c.id);
    expect(r.plan.step).toBe('run-stage');
    expect(job.repo).toBe('github.com/acme/local');
    expect(job.repoPath).toBe(local);
    expect(job.worktreePath).toBe(c.wt);
    expect(events(c.id)).toContain('repo.repointed');
    // Removing the remote again is just another remote change.
    gitIn(local, 'remote', 'remove', 'origin');
    createWorktree(store, c.id, { token: r.token });
    expect(getJob(store.db, c.id).repo).toBe(basename(local).toLowerCase());
  });

  it('origin URL changed after creation: resume and verify keep working', () => {
    const { clone, bare } = makeRepoWithOrigin('git@github.com:acme/alpha.git');
    dirs.push(clone, bare);
    const c = start(clone);
    gitIn(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/renamed.git');
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    expect(getJob(store.db, c.id).repo).toBe('github.com/acme/renamed');
    const ctx = { ...c, token: r.token };
    go(store, ctx, 'start');
    add(store, ctx, 'spec.md');
    go(store, ctx, 'complete');
    go(store, ctx, 'start');
    commitFile(c.wt, 'src/x.ts', 'x');
    expect(verify(store, ctx).status).toBe('passed');
  });

  it('a repository path with spaces survives a remote change', () => {
    const local = localRepo(tempDir('orch local with spaces-'));
    const c = start(local);
    gitIn(local, 'remote', 'add', 'origin', 'https://github.com/acme/spaced.git');
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    expect(r.job.repo).toBe('github.com/acme/spaced');
    expect(r.job.worktreePath).toBe(c.wt);
  });

  it('the main checkout and its linked worktrees are one repository', () => {
    const { clone, bare } = makeRepoWithOrigin();
    dirs.push(clone, bare);
    const c = start(clone);
    const job = getJob(store.db, c.id);
    expect(sameLocalRepo(job, c.wt)).toBe(true);
    // Naming a worktree keeps the recorded checkout as the root; nothing is re-pointed.
    const r = jobCheckout(store, job, { token: c.token }, c.wt);
    expect(r.root).toBe(clone);
    expect(r.job.repoPath).toBe(clone);
    expect(events(c.id)).not.toContain('repo.repointed');
    // Discoverable from the worktree even while the stored identity is stale.
    gitIn(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/renamed.git');
    expect(findJobs(store, { repo: c.wt }).map((j) => j.id)).toEqual([c.id]);
    expect(findJobs(store, { repo: clone }).map((j) => j.id)).toEqual([c.id]);
    expect(findJobs(store, { repo: 'github.com/acme/alpha' }).map((j) => j.id)).toEqual([c.id]);
  });

  it('two unrelated repositories with the same directory name are never conflated', () => {
    const a = localRepo(join(tempDir('orch-a-'), 'proj'));
    const b = localRepo(join(tempDir('orch-b-'), 'proj'));
    const ca = start(a);
    const cb = start(b, 'Other job');
    expect(getJob(store.db, ca.id).repo).toBe(getJob(store.db, cb.id).repo);
    expect(sameLocalRepo(getJob(store.db, ca.id), b)).toBe(false);
    expect(() => createWorktree(store, ca.id, { token: ca.token }, { repo: b })).toThrow(
      /belongs to proj/,
    );
    expect(findJobs(store, { repo: a }).map((j) => j.id)).toEqual([ca.id]);
    expect(findJobs(store, { repo: b }).map((j) => j.id)).toEqual([cb.id]);
    // A clone of the same remote is still accepted when named explicitly.
    const { clone, bare } = makeRepoWithOrigin();
    dirs.push(clone, bare);
    const second = tempDir('orch-clone2-');
    dirs.push(second);
    gitIn(second, 'clone', '-q', bare, '.');
    gitIn(second, 'remote', 'set-url', 'origin', 'git@github.com:acme/alpha.git');
    const cc = start(clone, 'Clone job');
    expect(jobCheckout(store, getJob(store.db, cc.id), { token: cc.token }, second).root).toBe(
      second,
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows: another spelling of the checkout (case, 8.3 alias) is the same repository',
    (ctx) => {
      const local = localRepo();
      const c = start(local);
      const job = getJob(store.db, c.id);
      expect(sameLocalRepo(job, local.toUpperCase())).toBe(true);
      expect(jobCheckout(store, job, { token: c.token }, local.toUpperCase()).root).toBe(local);
      const long = realpathSync.native(local);
      const short = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      }).stdout.trim();
      if (!short || short.toLowerCase() === long.toLowerCase()) ctx.skip();
      expect(sameLocalRepo(job, short)).toBe(true);
      expect(findJobs(store, { repo: short }).map((j) => j.id)).toEqual([c.id]);
    },
  );
});

describe('existing jobs with older stored identities', () => {
  it('a job recorded by directory name is recovered once its checkout has a remote', () => {
    const { clone, bare } = makeRepoWithOrigin('git@github.com:acme/alpha.git');
    dirs.push(clone, bare);
    const legacy = createJob(store, {
      title: 'Legacy',
      repo: basename(clone).toLowerCase(),
      repoPath: clone,
      baseBranch: 'main',
    });
    const { token } = claimJob(store, legacy.id, { session: SESSION });
    // Without a worktree nothing proves the checkout was not replaced: explicit confirmation.
    expect(() => createWorktree(store, legacy.id, { token })).toThrow(/orch job repo/);
    expect(getJob(store.db, legacy.id).repo).toBe(basename(clone).toLowerCase());
    expect(events(legacy.id)).not.toContain('repo.repointed');
    expect(repointRepo(store, legacy.id, { token }).repo).toBe('github.com/acme/alpha');
    expect(events(legacy.id)).toContain('repo.repointed');
    const r = createWorktree(store, legacy.id, { token });
    expect(r.created).toBe(true);
    // The manual command is now a no-op for the same clone and still refuses another repository.
    expect(repointRepo(store, legacy.id, { token }).repo).toBe('github.com/acme/alpha');
    const other = localRepo();
    expect(() => repointRepo(store, legacy.id, { token }, other)).toThrow(ValidationError);
    expect(getJob(store.db, legacy.id).repoPath).toBe(clone);
  });

  it('a checkout replaced by an unrelated repository is refused, never adopted', () => {
    const local = localRepo(join(tempDir('orch-replaced-'), 'proj'));
    const c = start(local);
    const before = getJob(store.db, c.id);
    rmSync(local, { recursive: true, force: true });
    mkdirSync(local);
    makeRepo('https://github.com/intruder/proj.git', local);
    const refused = /was replaced, not re-pointed/;
    expect(() => createWorktree(store, c.id, { token: c.token })).toThrow(refused);
    expect(() => integrateBase(store, c.id, { token: c.token })).toThrow(refused);
    // Operator confirmation cannot override the worktree's evidence either.
    expect(() => repointRepo(store, c.id, { token: c.token })).toThrow(refused);
    expect(() => repointRepo(store, c.id, { token: c.token }, local)).toThrow(refused);
    expect(() => resumeFactoryJob(store, c.id, { session: SESSION })).toThrow(refused);
    expect(getJob(store.db, c.id)).toMatchObject({
      repo: before.repo,
      repoPath: before.repoPath,
      worktreePath: before.worktreePath,
    });
    expect(events(c.id)).not.toContain('repo.repointed');
  });

  it('an identity that cannot be reconciled fails with a specific diagnostic', () => {
    const gone = join(tempDir('orch-gone-'), 'proj');
    const other = localRepo(join(tempDir('orch-other-'), 'proj'));
    gitIn(other, 'remote', 'add', 'origin', 'https://github.com/acme/proj.git');
    const job = createJob(store, {
      title: 'Orphan',
      repo: 'proj',
      repoPath: gone,
      baseBranch: 'main',
    });
    const { token } = claimJob(store, job.id, { session: SESSION });
    expect(() => createWorktree(store, job.id, { token })).toThrow(/does not exist/);
    let message = '';
    try {
      createWorktree(store, job.id, { token }, { repo: other });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('github.com/acme/proj'); // resolved identity
    expect(message).toContain('belongs to proj'); // stored identity
    expect(message).toContain(gone); // recorded checkout
    expect(message).toContain('missing');
    expect(message).toContain('directory name'); // why no remote can prove a match
    expect(getJob(store.db, job.id)).toMatchObject({ repo: 'proj', repoPath: gone });
    expect(events(job.id)).not.toContain('repo.repointed');
  });
});

describe('recovery stays within ownership and worktree boundaries', () => {
  it('a live lease blocks recovery by another session and leaves the identity untouched', () => {
    const local = localRepo();
    const c = start(local);
    gitIn(local, 'remote', 'add', 'origin', 'https://github.com/acme/local.git');
    expect(() => resumeFactoryJob(store, c.id, { session: 'intruder' })).toThrow(OwnershipError);
    expect(() => repointRepo(store, c.id, { token: 'bad' })).toThrow(OwnershipError);
    expect(getJob(store.db, c.id)).toMatchObject({
      repo: basename(local).toLowerCase(),
      ownerSession: SESSION,
    });
    expect(events(c.id)).not.toContain('repo.repointed');
    // The owner (or a forced takeover) recovers it.
    const r = resumeFactoryJob(store, c.id, { session: 'later', force: true });
    expect(r.tookOver).toBe(true);
    expect(getJob(store.db, c.id).repo).toBe('github.com/acme/local');
  });

  it("recovery never adopts another job's worktree", () => {
    const local = localRepo();
    const a = start(local, 'First');
    const b = start(local, 'Second');
    gitIn(local, 'remote', 'add', 'origin', 'https://github.com/acme/local.git');
    const ra = resumeFactoryJob(store, a.id, { session: SESSION });
    expect(ra.job.worktreePath).toBe(a.wt);
    expect(getJob(store.db, b.id).worktreePath).toBe(b.wt);
    expect(() => adoptWorktree(store, a.id, { token: ra.token }, b.wt)).toThrow(/already assigned/);
    // Naming B's worktree as the repository still roots A at the shared checkout.
    expect(jobCheckout(store, getJob(store.db, a.id), { token: ra.token }, b.wt).root).toBe(local);
    expect(getJob(store.db, a.id).worktreePath).toBe(a.wt);
  });

  it('verification and approval evidence survive a remote change', () => {
    const { clone, bare } = makeRepoWithOrigin('git@github.com:acme/alpha.git');
    dirs.push(clone, bare);
    const c = start(clone);
    go(store, c, 'start');
    add(store, c, 'spec.md');
    go(store, c, 'complete');
    go(store, c, 'start');
    commitFile(c.wt, 'src/x.ts', 'x');
    const run = verify(store, c);
    add(store, c, 'build.md');
    const before = {
      artifacts: listArtifacts(store.db, c.id),
      events: events(c.id).length,
      verification: showVerification(store, c.id),
    };
    expect(before.verification?.valid).toBe(true);
    gitIn(clone, 'remote', 'set-url', 'origin', 'https://github.com/acme/renamed.git');
    const r = resumeFactoryJob(store, c.id, { session: SESSION });
    expect(r.job.repo).toBe('github.com/acme/renamed');
    expect(listArtifacts(store.db, c.id)).toEqual(before.artifacts);
    expect(run.status).toBe('passed');
    expect(showVerification(store, c.id)).toEqual(before.verification);
    expect(events(c.id).length).toBeGreaterThan(before.events);
    expect(existsSync(c.wt)).toBe(true);
  });
});

describe('through the CLI', () => {
  it('job list --repo and factory resume work from the linked worktree after origin is added', () => {
    const home = tempDir('orch-home-');
    dirs.push(home);
    const local = localRepo();
    const s = json<{ job: { id: string; worktreePath: string } }>(
      orch(home, local, ['--json', 'factory', 'start', '--title', 'T', '--session', 'one']),
    );
    gitIn(local, 'remote', 'add', 'origin', 'https://github.com/acme/local.git');
    const wt = s.job.worktreePath;
    const listed = json<{ id: string }[]>(orch(home, wt, ['--json', 'job', 'list', '--repo', wt]));
    expect(listed.map((j) => j.id)).toEqual([s.job.id]);
    const r = orch(home, wt, [
      '--json',
      'factory',
      'resume',
      s.job.id,
      '--session',
      'two',
      '--force',
    ]);
    expect(r.code).toBe(0);
    expect(json<{ job: { repo: string } }>(r).job.repo).toBe('github.com/acme/local');
  });
});
