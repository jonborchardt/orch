import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ToolError, ValidationError } from '../src/core/errors.ts';
import { jobWorktreeDir } from '../src/core/paths.ts';
import { describeRepo } from '../src/git/repo.ts';
import {
  adoptWorktree,
  createWorktree,
  dropWorktree,
  integrateBase,
  jobBranch,
  showWorktree,
} from '../src/ops/worktree.ts';
import { openStore, type Store } from '../src/storage/client.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob } from '../src/storage/jobs.ts';
import {
  commitFile,
  gitIn,
  homePaths,
  json,
  makeRepo,
  makeRepoWithOrigin,
  orch,
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
  ({ clone, bare } = makeRepoWithOrigin());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare, ...extra.splice(0)]) rmSync(d, { recursive: true, force: true });
});

function newJob(s: Store = store, repoPath = clone, title = 'Add CSV export') {
  const repo = describeRepo(repoPath);
  const job = createJob(s, { title, repo: repo.identity, repoPath: repo.root, baseBranch: 'main' });
  const { token } = claimJob(s, job.id, { session: 's1' });
  return { id: job.id, token, repo: repo.identity };
}

describe('worktree create', () => {
  it('creates an isolated worktree and branch under the data dir, idempotently', () => {
    const { id, token, repo } = newJob();
    const first = createWorktree(store, id, { token });
    expect(first.created).toBe(true);
    const expected = jobWorktreeDir(id, repo, store.paths);
    expect(first.job.worktreePath).toBe(expected);
    expect(first.job.branch).toBe(`factory/${id}-add-csv-export`);
    expect(first.worktree.isWorktree).toBe(true);
    expect(first.worktree.branch).toBe(first.job.branch);
    expect(first.worktree.dirty).toEqual([]);
    expect(first.worktree.baseRef).toBe('origin/main');
    expect([first.worktree.ahead, first.worktree.behind]).toEqual([0, 0]);
    expect(existsSync(join(expected, '.git'))).toBe(true);
    // The project checkout itself is untouched and still on main.
    expect(gitIn(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitIn(clone, 'status', '--porcelain')).toBe('');

    const second = createWorktree(store, id, { token });
    expect(second.created).toBe(false);
    expect(second.job.worktreePath).toBe(expected);
    expect(second.job.revision).toBe(first.job.revision);
    const types = listEvents(store.db, id).map((e) => e.type);
    expect(types.filter((t) => t === 'worktree.created')).toHaveLength(1);
  });

  it('recreates the worktree on the existing branch when the directory disappeared', () => {
    const { id, token } = newJob();
    const first = createWorktree(store, id, { token });
    const sha = commitFile(first.job.worktreePath ?? '', 'a.txt', 'a');
    rmSync(first.job.worktreePath ?? '', { recursive: true, force: true });
    const again = createWorktree(store, id, { token });
    expect(again.created).toBe(true);
    expect(again.worktree.head).toBe(sha); // commits on the branch survived
    expect(again.worktree.commits.map((c) => c.subject)).toEqual(['add a.txt']);
  });

  it('requires ownership: unclaimed job, wrong token, and a reclaimed (stale) session', () => {
    const repo = describeRepo(clone);
    const job = createJob(store, {
      title: 't',
      repo: repo.identity,
      repoPath: clone,
      baseBranch: 'main',
    });
    expect(() => createWorktree(store, job.id, { token: undefined })).toThrow(OwnershipError);
    const { token } = claimJob(store, job.id, { session: 's1', leaseMinutes: 0 });
    expect(() => createWorktree(store, job.id, { token: 'nope' })).toThrow(OwnershipError);
    createWorktree(store, job.id, { token });
    // Another session takes over the lapsed lease; the old token is now stale everywhere.
    const taken = claimJob(store, job.id, { session: 's2' });
    expect(() => showWorktree(store, job.id)).not.toThrow(); // read-only needs no token
    expect(() => dropWorktree(store, job.id, { token })).toThrow(/Stale or invalid token/);
    expect(() => createWorktree(store, job.id, { token, expectRevision: 1 })).toThrow(
      OwnershipError,
    );
    expect(dropWorktree(store, job.id, { token: taken.token }).job.worktreePath).toBeNull();
  });

  it('validates repository identity and the checkout location', () => {
    const other = makeRepo('git@github.com:acme/other.git');
    extra.push(other);
    const job = createJob(store, {
      title: 't',
      repo: 'github.com/acme/alpha',
      repoPath: other,
      baseBranch: 'main',
    });
    const { token } = claimJob(store, job.id, { session: 's1' });
    expect(() => createWorktree(store, job.id, { token })).toThrow(
      /belongs to github.com\/acme\/alpha/,
    );
    // --repo can point at a different clone of the right repository, which is then recorded.
    const r = createWorktree(store, job.id, { token }, { repo: clone });
    expect(r.created).toBe(true);
    expect(getJob(store.db, job.id).repoPath).toBe(describeRepo(clone).root);
    // A missing checkout is reported, not silently recreated.
    const gone = createJob(store, {
      title: 't2',
      repo: 'github.com/acme/alpha',
      repoPath: join(tmpdir(), 'does-not-exist-orch'),
      baseBranch: 'main',
    });
    const c2 = claimJob(store, gone.id, { session: 's1' });
    expect(() => createWorktree(store, gone.id, { token: c2.token })).toThrow(/does not exist/);
  });

  it('handles data dirs and repositories whose paths contain spaces', () => {
    const home = tempDir('orch home ');
    const repoDir = tempDir('orch repo with space ');
    extra.push(home, repoDir);
    const spaced = makeRepoWithOrigin('git@github.com:acme/spaced.git', repoDir);
    extra.push(spaced.bare);
    const s = openStore(homePaths(home));
    try {
      const { id, token } = newJob(s, spaced.clone, 'Fix the thing (now!)');
      const r = createWorktree(s, id, { token });
      expect(r.created).toBe(true);
      expect(r.job.worktreePath).toContain('orch home ');
      expect(r.job.branch).toBe(`factory/${id}-fix-the-thing-now`);
      commitFile(r.job.worktreePath ?? '', 'dir with space/file.txt', 'x');
      const shown = showWorktree(s, id);
      expect(shown.worktree.changedFiles).toEqual(['dir with space/file.txt']);
      expect(dropWorktree(s, id, { token }).worktree.exists).toBe(false);
    } finally {
      s.close();
    }
  });

  it("refuses a path that exists but is not this job's worktree", () => {
    const { id, token, repo } = newJob();
    const path = jobWorktreeDir(id, repo, store.paths);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'junk.txt'), 'x');
    expect(() => createWorktree(store, id, { token })).toThrow(/not a worktree/);
    expect(existsSync(join(path, 'junk.txt'))).toBe(true); // never deleted
  });
});

describe('worktree show, adopt, remove', () => {
  it('show is read-only and reports commits, changed files, and ahead/behind vs base', () => {
    const { id, token } = newJob();
    const before = showWorktree(store, id);
    expect(before.worktree.exists).toBe(false);
    const r = createWorktree(store, id, { token });
    const wt = r.job.worktreePath ?? '';
    commitFile(wt, 'src/a.ts', 'a');
    commitFile(wt, 'src/b.ts', 'b');
    writeFileSync(join(wt, 'untracked.txt'), 'u');
    writeFileSync(join(wt, 'src', 'a.ts'), 'a2'); // unstaged: " M src/a.ts" is the first status line
    const shown = showWorktree(store, id);
    expect(shown.worktree.commits.map((c) => c.subject)).toEqual(['add src/b.ts', 'add src/a.ts']);
    expect(shown.worktree.changedFiles.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(shown.worktree.dirty).toEqual(['src/a.ts', 'untracked.txt']);
    expect([shown.worktree.ahead, shown.worktree.behind]).toEqual([2, 0]);
    expect(getJob(store.db, id).revision).toBe(r.job.revision); // no write
  });

  it('never removes a worktree with uncommitted work; a clean one is removed and the branch kept', () => {
    const { id, token } = newJob();
    const r = createWorktree(store, id, { token });
    const wt = r.job.worktreePath ?? '';
    writeFileSync(join(wt, 'wip.txt'), 'precious');
    expect(() => dropWorktree(store, id, { token })).toThrow(/uncommitted changes \(wip.txt\)/);
    expect(existsSync(join(wt, 'wip.txt'))).toBe(true);
    commitFile(wt, 'wip.txt', 'precious');
    const dropped = dropWorktree(store, id, { token });
    expect(dropped.job.worktreePath).toBeNull();
    expect(dropped.job.branch).toBe(r.job.branch);
    expect(existsSync(wt)).toBe(false);
    expect(gitIn(clone, 'rev-parse', '--verify', `refs/heads/${r.job.branch ?? ''}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(listEvents(store.db, id).at(-1)?.type).toBe('worktree.removed');
    // Removing again is a validation error, and a job without a worktree says so.
    expect(() => dropWorktree(store, id, { token })).toThrow(/has no worktree/);
  });

  it('forgets a worktree whose directory is already gone', () => {
    const { id, token } = newJob();
    const r = createWorktree(store, id, { token });
    rmSync(r.job.worktreePath ?? '', { recursive: true, force: true });
    const dropped = dropWorktree(store, id, { token });
    expect(dropped.job.worktreePath).toBeNull();
    expect(listEvents(store.db, id).at(-1)?.payload).toMatchObject({ reason: 'missing' });
  });

  it('adopt records an existing worktree once; two jobs cannot share one', () => {
    const a = newJob();
    const b = newJob(store, clone, 'Second job');
    const manual = join(tempDir('orch-manual-'), 'wt');
    extra.push(join(manual, '..'));
    gitIn(clone, 'worktree', 'add', '-q', '-b', 'feature/manual', manual, 'main');

    expect(() => adoptWorktree(store, a.id, { token: a.token }, clone)).toThrow(/primary checkout/);
    expect(() => adoptWorktree(store, a.id, { token: a.token }, tmpdir())).toThrow(
      /not a worktree/,
    );
    expect(() => adoptWorktree(store, a.id, { token: a.token }, join(tmpdir(), 'nope-x'))).toThrow(
      /does not exist/,
    );
    const adopted = adoptWorktree(store, a.id, { token: a.token }, manual);
    expect(adopted.job.branch).toBe('feature/manual');
    expect(adopted.job.worktreePath).toBe(manual);
    expect(() => adoptWorktree(store, b.id, { token: b.token }, manual)).toThrow(
      /already assigned to job/,
    );
    // A managed path belonging to job A cannot be adopted by job B either.
    const created = createWorktree(store, b.id, { token: b.token });
    expect(() =>
      adoptWorktree(store, a.id, { token: a.token }, created.job.worktreePath ?? ''),
    ).toThrow(/already assigned/);
  });

  it('a job cannot take a branch another job in the same repository owns', () => {
    const a = newJob();
    const b = newJob(store, clone, 'Second job');
    const first = createWorktree(store, a.id, { token: a.token });
    const manual = join(tempDir('orch-manual-'), 'wt');
    extra.push(join(manual, '..'));
    gitIn(clone, 'worktree', 'add', '-q', '-b', 'tmp-branch', manual, 'main');
    // Git refuses to check out one branch in two worktrees, so make the collision by renaming:
    // move A's branch name onto the manual worktree and let B try to adopt it.
    gitIn(clone, 'branch', '-m', first.job.branch ?? '', 'renamed-away');
    gitIn(manual, 'branch', '-m', 'tmp-branch', first.job.branch ?? '');
    expect(() => adoptWorktree(store, b.id, { token: b.token }, manual)).toThrow(
      /already belongs to job/,
    );
  });
});

describe('worktree integrate', () => {
  it('merges new base commits (fetched from origin) and is a no-op when up to date', () => {
    const { id, token } = newJob();
    const r = createWorktree(store, id, { token });
    const wt = r.job.worktreePath ?? '';
    commitFile(wt, 'feature.txt', 'f');
    // Base advances in the primary checkout and is pushed.
    commitFile(clone, 'base.txt', 'b');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    // Pushing from the clone updated its origin/main tracking ref, so the gap is visible already.
    expect(showWorktree(store, id).worktree.behind).toBe(1);
    const merged = integrateBase(store, id, { token });
    expect(merged.fetched).toBe(true);
    expect(merged.merge.merged).toBe(true);
    expect(existsSync(join(wt, 'base.txt'))).toBe(true);
    expect(merged.worktree.behind).toBe(0);
    expect(merged.worktree.dirty).toEqual([]);
    const again = integrateBase(store, id, { token });
    expect(again.merge.upToDate).toBe(true);
    const done = listEvents(store.db, id).filter((e) => e.type === 'integration.completed');
    expect(done.map((e) => e.payload['status'])).toEqual(['merged', 'up-to-date']);
    expect(merged.integration.changedFiles).toEqual(['base.txt']);
    expect(merged.integration.material).toEqual([]);
  });

  it('aborts on conflict, leaving the worktree exactly as it was', () => {
    const { id, token } = newJob();
    const r = createWorktree(store, id, { token });
    const wt = r.job.worktreePath ?? '';
    const head = commitFile(wt, 'same.txt', 'ours');
    commitFile(clone, 'same.txt', 'theirs');
    gitIn(clone, 'push', '-q', 'origin', 'main');
    expect(() => integrateBase(store, id, { token })).toThrow(ToolError);
    try {
      integrateBase(store, id, { token });
    } catch (err) {
      expect((err as Error).message).toMatch(/conflicts in: same.txt/);
    }
    const after = showWorktree(store, id);
    expect(after.worktree.head).toBe(head);
    expect(after.worktree.dirty).toEqual([]);
    // Both attempts were recorded as conflicts; nothing was merged.
    const done = listEvents(store.db, id).filter((e) => e.type === 'integration.completed');
    expect(done.map((e) => e.payload['status'])).toEqual(['conflict', 'conflict']);
  });

  it('refuses to integrate over uncommitted changes', () => {
    const { id, token } = newJob();
    const r = createWorktree(store, id, { token });
    writeFileSync(join(r.job.worktreePath ?? '', 'x.txt'), 'x');
    expect(() => integrateBase(store, id, { token })).toThrow(ValidationError);
  });
});

describe('orch worktree CLI', () => {
  it('create/show/remove through the CLI with --json; usage errors are exit 2', () => {
    const home = tempDir('orch-cli-wt-');
    extra.push(home);
    const created = json<{ jobId: string; token: string }>(
      orch(home, clone, ['--json', 'job', 'create', '--title', 'CLI wt']),
    );
    const claim = json<{ token: string }>(
      orch(home, clone, ['--json', 'job', 'claim', created.jobId, '--session', 'cli']),
    );
    const env = { ORCH_TOKEN: claim.token };
    expect(orch(home, tmpdir(), ['worktree']).code).toBe(2);
    expect(orch(home, tmpdir(), ['worktree', 'create']).code).toBe(2);
    expect(orch(home, tmpdir(), ['worktree', 'bogus', created.jobId]).code).toBe(2);
    expect(orch(home, tmpdir(), ['worktree', 'create', created.jobId]).code).toBe(4);
    const r = json<{ created: boolean; job: { worktreePath: string; branch: string } }>(
      orch(home, tmpdir(), ['--json', 'worktree', 'create', created.jobId], env),
    );
    expect(r.created).toBe(true);
    expect(r.job.worktreePath.startsWith(home)).toBe(true);
    const shown = orch(home, tmpdir(), ['worktree', 'show', created.jobId]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(r.job.branch);
    writeFileSync(join(r.job.worktreePath, 'dirty.txt'), 'd');
    const refused = orch(home, tmpdir(), ['worktree', 'remove', created.jobId], env);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('uncommitted');
    rmSync(join(r.job.worktreePath, 'dirty.txt'));
    expect(orch(home, tmpdir(), ['worktree', 'remove', created.jobId], env).code).toBe(0);
    expect(orch(home, tmpdir(), ['worktree', 'adopt', created.jobId], env).code).toBe(2);
  });

  it('jobBranch slugs titles safely', () => {
    expect(jobBranch({ id: 'job-1', title: '  Ünïcode & spaces!!  ' })).toBe(
      'factory/job-1-n-code-spaces',
    );
    expect(jobBranch({ id: 'job-2', title: '!!!' })).toBe('factory/job-2');
    expect(jobBranch({ id: 'job-3', title: 'x'.repeat(100) }).length).toBeLessThanOrEqual(60);
  });
});
