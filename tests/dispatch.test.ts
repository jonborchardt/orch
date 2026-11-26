/**
 * Phase 3: dispatching jobs to other repositories, independent sessions adopting their worktrees,
 * session association, and the initiating session's view of all its jobs. Deterministic: a
 * session started in a linked worktree is simulated with `git worktree add`. Dispatch returns no
 * launch recipe (decision 2026-11-25-retire-dispatch-launch).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, UsageError, ValidationError } from '../src/core/errors.ts';
import { canonicalPath } from '../src/core/paths.ts';
import { SESSION_EVENT, sessionLinks, validateSessionRef } from '../src/core/session.ts';
import { dispatchJob, listFactory, normalizeIssue } from '../src/ops/dispatch.ts';
import { planJob, resumeFactoryJob, startJob } from '../src/ops/factory.ts';
import { transitionGuarded } from '../src/ops/gates.ts';
import { detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  attachSession,
  claimJob,
  getJob,
  listJobs,
  sessionsByJob,
  transitionJob,
} from '../src/storage/jobs.ts';
import { dirtyFiles } from '../src/git/repo.ts';
import {
  commitFile,
  type GhShim,
  gitIn,
  json,
  makeRepo,
  makeRepoWithOrigin,
  NOOP_POLICY,
  orch,
  tempDir,
  type TempStore,
  useJobRepo,
} from './helpers.ts';

const PARENT = 'claude-20261114-0900-aaaa';
const LINK = 'agent-host-session://ahp-session/17b6e18f-4046-422b-8336-cb43a130967f';
const LINK2 = 'agent-host-session://ahp-session/d6e49339-006b-4dc0-a682-0f48a6a9e441';
const UUID = '565e2b23-152d-4533-b6b3-e1d4981c7297';

let store: TempStore;
let alpha: string;
let beta: string;
let shim: GhShim;
const dirs: string[] = [];

useJobRepo({ shim: 'acme/beta' }, (s) => ({ store, clone: alpha, shim } = s));
beforeEach(() => {
  const b = makeRepoWithOrigin('git@github.com:acme/beta.git');
  beta = b.clone;
  dirs.push(b.clone, b.bare);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What VS Code's Agents window makes for a session with its own worktree. */
function hostWorktree(repo: string, name: string): string {
  const dir = tempDir('orch-host-wt-');
  dirs.push(dir);
  gitIn(repo, 'worktree', 'add', '-q', dir, '-b', `agents/${name}`);
  return dir;
}

const dispatch = (repo: string, over: Record<string, string> = {}) =>
  dispatchJob(store, {
    repo,
    title: 'Beta feature',
    description: 'Test request',
    session: PARENT,
    cwd: alpha,
    ...over,
  });

describe('dispatch prepares a job for another repository', () => {
  it('from repository A, creates an unowned job for repository B and touches neither', () => {
    const r = dispatch(beta);
    expect(r.duplicate).toBe(false);
    expect(r.readiness.status).toBe('ready');
    expect(r.job.repo).toBe('github.com/acme/beta');
    expect(r.job.repoPath).toBe(beta);
    expect(r.job.baseBranch).toBe('main');
    expect([r.job.stage, r.job.status]).toEqual(['spec', 'pending']);
    expect(r.job.ownerSession).toBeNull();
    expect(r.job.worktreePath).toBeNull();
    // No launch recipe: dispatch only creates the job.
    expect(r).not.toHaveProperty('launch');
    // Neither repository changed: no files, no worktrees, no branches.
    for (const repo of [alpha, beta]) {
      expect(dirtyFiles(repo)).toEqual([]);
      expect(gitIn(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
      expect(gitIn(repo, 'branch', '--list').trim()).toBe('* main');
    }
    const created = listEvents(store.db, r.job.id).find((e) => e.type === 'job.created');
    expect(created?.actor).toBe(PARENT);
  });

  it('targets the current directory when --repo is omitted', () => {
    const r = dispatchJob(store, {
      title: 'Alpha feature',
      description: 'Test request',
      session: PARENT,
      cwd: alpha,
    });
    expect(r.job.repo).toBe('github.com/acme/alpha');
    expect(r.job.repoPath).toBe(alpha);
  });

  it('refuses a repository whose policy is missing or uncommitted, creating nothing', () => {
    const bare = makeRepo('https://github.com/acme/gamma');
    dirs.push(bare);
    expect(() => dispatch(bare)).toThrow(/not ready for the factory \(missing\)/);
    writeFileSync(join(bare, 'factory.json'), NOOP_POLICY);
    expect(() => dispatch(bare)).toThrow(/\(uncommitted\)/);
    expect(() => dispatch(tmpdir())).toThrow(/\(no-git-repository\)/);
    expect(listJobs(store.db)).toEqual([]);
  });

  it('accepts a repository without origin; refuses a base branch that does not exist', () => {
    const local = makeRepo();
    dirs.push(local);
    commitFile(local, 'factory.json', NOOP_POLICY);
    const r = dispatch(local);
    expect(r.job.repo).toBe(local.split(/[\\/]/).pop()?.toLowerCase());
    expect(() => dispatch(local, { base: 'nope' })).toThrow(/\(no-base-branch\)/);
    expect(() => dispatch(beta, { base: 'nope' })).toThrow(/Nothing was created/);
    expect(listJobs(store.db)).toHaveLength(1);
  });

  it('a repeated dispatch for the same issue returns the existing active job, never a second one', () => {
    const first = dispatch(beta, { issue: '#45' });
    expect(first.job.issueRef).toBe('#45');
    const again = dispatch(beta, { issue: '45', title: 'Different title' });
    expect(again.duplicate).toBe(true);
    expect(again.job.id).toBe(first.job.id);
    expect(again).not.toHaveProperty('launch');
    expect(dispatch(beta, { issue: '#46' }).job.id).not.toBe(first.job.id);
    // Another clone of the same remote counts as the same repository.
    expect(dispatch(alpha, { issue: '#45' }).job.id).not.toBe(first.job.id);
    // A finished job does not block a new one for the same issue.
    const { token } = claimJob(store, first.job.id, { session: PARENT });
    transitionJob(store, first.job.id, 'cancel', { token, reason: 'test' });
    const fresh = dispatch(beta, { issue: '#45' });
    expect(fresh.duplicate).toBe(false);
    expect(fresh.job.id).not.toBe(first.job.id);
    expect(normalizeIssue(' 7 ')).toBe('#7');
    expect(normalizeIssue('https://github.com/acme/beta/issues/7')).toBe(
      'https://github.com/acme/beta/issues/7',
    );
  });

  it('fetches the title from the issue through gh when only --issue is given', () => {
    shim.reset('acme/beta');
    const r = dispatchJob(store, { repo: beta, issue: '12', session: PARENT, cwd: alpha });
    expect(r.job.title).toBe('Export CSV');
    expect(r.job.issueRef).toBe('#12');
    expect(r.job.description).toContain('https://github.com/acme/beta/issues/12');
  });

  it('with --title and --issue but no --description, the description still comes from the issue', () => {
    shim.reset('acme/beta');
    const d = dispatchJob(store, {
      repo: beta,
      title: 'Own title',
      issue: '12',
      session: PARENT,
      cwd: alpha,
    });
    expect(d.job.title).toBe('Own title');
    expect(d.job.description).toContain('https://github.com/acme/beta/issues/12');
    const s = startJob(store, {
      repo: beta,
      title: 'Own start title',
      issue: '#12',
      session: 'child-s',
      cwd: alpha,
    });
    expect(s.job.title).toBe('Own start title');
    expect(s.job.description).toContain('https://github.com/acme/beta/issues/12');
    // An explicit blank --description wins over the issue and is refused.
    expect(() =>
      startJob(store, { repo: beta, issue: '#12', description: ' ', session: 'c', cwd: alpha }),
    ).toThrow(UsageError);
  });
});

describe('independent sessions adopt their worktrees and progress separately', () => {
  it('two jobs for one repository adopt two host-made worktrees; a third cannot take one of them', () => {
    const j1 = dispatch(beta, { issue: '#1' }).job;
    const j2 = dispatch(beta, { issue: '#2' }).job;
    const wt1 = hostWorktree(beta, 'one');
    const wt2 = hostWorktree(beta, 'two');
    const r1 = resumeFactoryJob(store, j1.id, { session: 'child-1', adopt: wt1 });
    expect(r1.adopted).toBe('adopted');
    expect(r1.tookOver).toBe(false);
    expect(r1.job.worktreePath).toBe(wt1);
    expect(r1.job.branch).toBe('agents/one');
    expect([r1.plan.step, r1.plan.stage, r1.plan.status]).toEqual(['run-stage', 'spec', 'pending']);
    expect(r1.plan.worktree?.path).toBe(wt1);
    const r2 = resumeFactoryJob(store, j2.id, { session: 'child-2', adopt: wt2 });
    expect(r2.job.worktreePath).toBe(wt2);
    // Resuming again with the same worktree is idempotent; a different one is kept out.
    expect(resumeFactoryJob(store, j1.id, { session: 'child-1', adopt: wt1 }).adopted).toBe(
      'kept-existing',
    );
    expect(getJob(store.db, j1.id).worktreePath).toBe(wt1);
    const j3 = dispatch(beta, { issue: '#3' }).job;
    expect(() => resumeFactoryJob(store, j3.id, { session: 'child-3', adopt: wt1 })).toThrow(
      /already assigned to job/,
    );
    expect(() => resumeFactoryJob(store, j3.id, { session: 'child-3', adopt: beta })).toThrow(
      /primary checkout/,
    );
    // Only orch-managed worktrees are created for jobs that adopt nothing.
    const r3 = resumeFactoryJob(store, j3.id, { session: 'child-3' });
    expect(r3.adopted).toBeNull();
    expect(r3.job.worktreePath).toContain(store.home);
    expect(r3.job.branch).toBe(`factory/${j3.id}-beta-feature`);
    // Separate artifact directories and event histories.
    expect(r1.plan.artifactDir).not.toBe(r2.plan.artifactDir);
    expect(listEvents(store.db, j1.id).every((e) => e.jobId === j1.id)).toBe(true);
  });

  it('a failed adoption leaves the job claimed by the child without a worktree; that child retries', () => {
    const job = dispatch(beta, { issue: '#4' }).job;
    const foreign = hostWorktree(alpha, 'foreign'); // the host made a worktree of the wrong repository
    const plain = tempDir('orch-plain-');
    dirs.push(plain);
    for (const dir of [foreign, plain]) {
      expect(() => resumeFactoryJob(store, job.id, { session: 'child-4', adopt: dir })).toThrow(
        /is not a worktree of .*without --adopt/,
      );
    }
    // The claim preceded the refusal: the child holds the job, nothing was adopted or created.
    const after = getJob(store.db, job.id);
    expect(after.worktreePath).toBeNull();
    expect(after.ownerSession).toBe('child-4');
    expect(listFactory(store).find((r) => r.id === job.id)).toMatchObject({
      owner: { session: 'child-4', live: true },
      worktreePath: null,
      resume: null,
    });
    expect(planJob(store, job.id).step).toBe('create-worktree');
    // Nobody else slips in while the lease is live; the parent's retry finds the same job.
    expect(() => resumeFactoryJob(store, job.id, { session: 'child-5' })).toThrow(OwnershipError);
    expect(dispatch(beta, { issue: '#4' })).toMatchObject({ duplicate: true, job: { id: job.id } });
    // The child resumes again from a worktree of the right repository.
    const wt = hostWorktree(beta, 'four');
    const r = resumeFactoryJob(store, job.id, { session: 'child-4', adopt: wt });
    expect(r.adopted).toBe('adopted');
    expect(r.job.worktreePath).toBe(wt);
    expect(listJobs(store.db)).toHaveLength(1);
    const taken = dispatch(beta, { issue: '#5' }).job;
    expect(() => resumeFactoryJob(store, taken.id, { session: 'child-6', adopt: wt })).toThrow(
      /already assigned to job .*from another worktree/,
    );
  });

  it('one refused dispatch leaves the job dispatched before it untouched', () => {
    const ok = dispatch(beta).job;
    const bare = makeRepo('https://github.com/acme/gamma');
    dirs.push(bare);
    expect(() => dispatch(bare)).toThrow(ValidationError);
    expect(getJob(store.db, ok.id)).toEqual(ok);
    expect(listFactory(store).map((r) => r.id)).toEqual([ok.id]);
  });

  it('a child that stops is taken over by another session: same job, new association, old one kept', () => {
    const job = dispatch(beta, { issue: '#9' }).job;
    const wt = hostWorktree(beta, 'nine');
    const r1 = resumeFactoryJob(store, job.id, { session: 'child-1', adopt: wt });
    attachSession(store, job.id, {
      session: validateSessionRef('vscode-agents', LINK, wt),
      token: r1.token,
    });
    transitionGuarded(store, job.id, 'start', { token: r1.token });
    // The lease is live, so a second session must take over deliberately (decision #31).
    expect(() => resumeFactoryJob(store, job.id, { session: 'child-2' })).toThrow(OwnershipError);
    const r2 = resumeFactoryJob(store, job.id, { session: 'child-2', force: true });
    expect(r2.tookOver).toBe(true);
    expect(r2.previousOwner).toBe('child-1');
    expect([r2.plan.stage, r2.plan.status]).toEqual(['spec', 'pending']);
    expect(r2.job.worktreePath).toBe(wt);
    attachSession(store, job.id, {
      session: validateSessionRef('vscode-agents', LINK2, wt),
      token: r2.token,
    });
    expect(listJobs(store.db)).toHaveLength(1);
    expect(sessionsByJob(store.db, [job.id]).get(job.id)?.ref).toBe(LINK2);
    const history = listEvents(store.db, job.id).filter((e) => e.type === SESSION_EVENT);
    expect(history.map((e) => e.payload['ref'])).toEqual([LINK, LINK2]);
    expect(history[1]?.payload['previous']).toEqual({ provider: 'vscode-agents', ref: LINK });
    expect(listEvents(store.db, job.id).some((e) => e.type === 'job.interrupted')).toBe(true);
  });
});

describe('a job created from a linked worktree belongs to the primary checkout', () => {
  it('dispatch records the primary checkout and its branch; the session adopts its worktree', () => {
    const linked = hostWorktree(beta, 'x');
    const r = dispatch(linked);
    expect(canonicalPath(r.job.repoPath)).toBe(canonicalPath(beta));
    expect(r.job.baseBranch).toBe('main');
    const resumed = resumeFactoryJob(store, r.job.id, { session: 'child-x', adopt: linked });
    expect(resumed.adopted).toBe('adopted');
    expect(resumed.job.worktreePath).toBe(linked);
  });

  it('start does the same; an explicit base still wins', () => {
    const linked = hostWorktree(beta, 'y');
    const s = startJob(store, {
      title: 'From a worktree',
      description: 'Test request',
      session: 'child-y',
      cwd: linked,
    });
    expect(canonicalPath(s.job.repoPath)).toBe(canonicalPath(beta));
    expect(s.job.baseBranch).toBe('main');
    const t = startJob(store, {
      title: 'Explicit base',
      description: 'Test request',
      session: 'child-z',
      cwd: alpha,
      repo: linked,
      base: 'agents/y',
    });
    expect(canonicalPath(t.job.repoPath)).toBe(canonicalPath(beta));
    expect(t.job.baseBranch).toBe('agents/y');
  });
});

describe('session association', () => {
  it('an unowned job accepts the launcher record; an owned job needs the owner token', () => {
    const job = dispatch(beta).job;
    const s = validateSessionRef('vscode-agents', LINK);
    const first = attachSession(store, job.id, { session: s, actor: PARENT });
    expect(first.changed).toBe(true);
    const ev = listEvents(store.db, job.id).find((e) => e.type === SESSION_EVENT);
    expect(ev?.actor).toBe(PARENT);
    expect(ev?.payload).toEqual({
      provider: 'vscode-agents',
      ref: LINK,
      cwd: null,
      previous: null,
    });
    const again = attachSession(store, job.id, { session: s, actor: PARENT });
    expect(again.changed).toBe(false);
    expect(again.job.revision).toBe(first.job.revision);
    const { token } = claimJob(store, job.id, { session: 'child-1' });
    expect(() => attachSession(store, job.id, { session: s })).toThrow(OwnershipError);
    expect(() => attachSession(store, job.id, { session: s, token: 'nope' })).toThrow(
      OwnershipError,
    );
    const second = attachSession(store, job.id, {
      session: validateSessionRef('claude-code', UUID, beta),
      token,
    });
    expect(second.changed).toBe(true);
    expect(sessionsByJob(store.db, [job.id]).get(job.id)).toEqual({
      provider: 'claude-code',
      ref: UUID,
      cwd: beta,
    });
    expect(listEvents(store.db, job.id).filter((e) => e.type === SESSION_EVENT)).toHaveLength(2);
  });

  it('validates providers and refs, and documents navigation per provider', () => {
    expect(() => validateSessionRef('copilot', LINK)).toThrow(/provider must be one of/);
    expect(() => validateSessionRef('vscode-agents', 'ahp-session:/abc')).toThrow(
      /agent-host-session/,
    );
    expect(() => validateSessionRef('claude-code', 'not-a-uuid')).toThrow(/UUID/);
    expect(validateSessionRef('claude-code', UUID.toUpperCase()).ref).toBe(UUID.toUpperCase());
    const host = sessionLinks(validateSessionRef('vscode-agents', LINK));
    expect(host.open).toEqual({ url: LINK, scope: 'vscode-chat' });
    expect(host.resume).toBeNull();
    expect(host.note).toMatch(/inside VS Code only/);
    const cli = sessionLinks(validateSessionRef('claude-code', UUID));
    expect(cli.open).toEqual({
      url: `vscode://anthropic.claude-code/open?session=${UUID}`,
      scope: 'os',
    });
    expect(cli.resume).toBe(`claude --resume ${UUID}`);
  });

  it('the initiating session sees attention, sessions, and resume commands per job', () => {
    const a = dispatch(beta, { issue: '#1' }).job;
    const b = dispatch(beta, { issue: '#2' }).job;
    let rows = listFactory(store);
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(row(a.id)).toMatchObject({
      owner: null,
      needsHuman: false,
      blockedReason: null,
      session: null,
      resume: `orch factory resume ${a.id} --session <name>`,
    });
    attachSession(store, a.id, {
      session: validateSessionRef('vscode-agents', LINK),
      actor: PARENT,
    });
    const rb = resumeFactoryJob(store, b.id, { session: 'child-2' });
    transitionGuarded(store, b.id, 'start', { token: rb.token });
    transitionGuarded(store, b.id, 'escalate', { token: rb.token, reason: 'needs a decision' });
    rows = listFactory(store, { repo: beta });
    expect(row(a.id)?.session).toEqual({ provider: 'vscode-agents', ref: LINK, cwd: null });
    expect(row(b.id)).toMatchObject({
      owner: { session: 'child-2', live: true },
      needsHuman: true,
      blockedReason: 'needs a decision',
      resume: null,
    });
    expect(listFactory(store, { repo: alpha })).toEqual([]);
  });

  it('the dashboard detail carries the current session with links and the count of earlier ones', () => {
    const job = dispatch(beta).job;
    expect(detail(store, job.id).session).toBeNull();
    attachSession(store, job.id, {
      session: validateSessionRef('vscode-agents', LINK),
      actor: PARENT,
    });
    attachSession(store, job.id, {
      session: validateSessionRef('vscode-agents', LINK2, beta),
      actor: PARENT,
    });
    const view = detail(store, job.id).session;
    expect(view).toMatchObject({
      provider: 'vscode-agents',
      ref: LINK2,
      cwd: beta,
      by: PARENT,
      previous: 1,
      links: { open: { url: LINK2, scope: 'vscode-chat' }, resume: null },
    });
  });
});

describe('CLI', () => {
  it('factory dispatch, list, resume --adopt, and job session attach, with their usage errors', () => {
    const home = store.home;
    const empty = orch(home, tmpdir(), ['factory', 'list']);
    expect([empty.code, empty.out.trim()]).toEqual([0, '(none)']);
    const r = orch(home, alpha, [
      '--json',
      'factory',
      'dispatch',
      '--repo',
      beta,
      '--title',
      'Beta via CLI',
      '--description',
      'Beta request',
      '--session',
      PARENT,
    ]);
    expect(r.code, r.err).toBe(0);
    const d = json<{
      session: string;
      job: { id: string; ownerSession: string | null };
      duplicate: boolean;
      readiness: { status: string };
    }>(r);
    expect(d.job.ownerSession).toBeNull();
    expect([d.session, d.duplicate, d.readiness.status]).toEqual([PARENT, false, 'ready']);
    expect(d).not.toHaveProperty('launch');
    expect(orch(home, alpha, ['factory', '--help']).out).not.toContain('(workspace, prompt)');
    expect(orch(home, alpha, ['factory', 'dispatch', '--session', PARENT]).code).toBe(2);
    expect(orch(home, alpha, ['factory', 'dispatch', '--title', 'x']).code).toBe(2);
    // A job needs a description: none, or a blank one, is a usage error that creates nothing.
    const bare = ['factory', 'dispatch', '--repo', beta, '--title', 't', '--session', PARENT];
    for (const extra of [[], ['--description', ' ']]) {
      const refused = orch(home, alpha, [...bare, ...extra]);
      expect(refused.code, refused.err).toBe(2);
      expect(refused.err).toContain('--description');
    }
    expect(listJobs(store.db).map((j) => j.id)).toEqual([d.job.id]);
    const list = json<{ id: string; resume: string | null }[]>(
      orch(home, tmpdir(), ['--json', 'factory', 'list']),
    );
    expect(list.map((x) => x.id)).toEqual([d.job.id]);
    expect(list[0]?.resume).toContain('orch factory resume');
    const text = orch(home, tmpdir(), ['factory', 'list']).out.split('\n').filter(Boolean);
    expect(text).toHaveLength(2);
    expect(text[0]?.split(/\s+/)).toEqual([
      'ID',
      'REPO',
      'STAGE',
      'STATUS',
      'ACTION',
      'PR',
      'UPDATED',
      'TITLE',
    ]);
    expect(text[1]?.startsWith(`${d.job.id} `)).toBe(true);
    expect(text[1]).toMatch(/\sresume\s.*Beta via CLI$/);

    const attach = orch(home, tmpdir(), [
      '--json',
      'job',
      'session',
      'attach',
      d.job.id,
      '--provider',
      'vscode-agents',
      '--ref',
      LINK,
      '--session',
      PARENT,
    ]);
    expect(attach.code, attach.err).toBe(0);
    expect(json<{ changed: boolean }>(attach).changed).toBe(true);
    expect(
      orch(home, tmpdir(), ['job', 'session', 'attach', d.job.id, '--provider', 'x', '--ref', LINK])
        .code,
    ).toBe(2);
    expect(
      orch(home, tmpdir(), ['job', 'session', 'attach', d.job.id, '--provider', 'claude-code'])
        .code,
    ).toBe(2);
    const bad = orch(home, tmpdir(), [
      'job',
      'session',
      'attach',
      d.job.id,
      '--provider',
      'claude-code',
      '--ref',
      'nope',
    ]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('UUID');

    const wt = hostWorktree(beta, 'cli');
    const resumed = orch(home, wt, [
      '--json',
      'factory',
      'resume',
      d.job.id,
      '--session',
      'child-cli',
      '--adopt',
      wt,
    ]);
    expect(resumed.code, resumed.err).toBe(0);
    const res = json<{ adopted: string; job: { worktreePath: string; branch: string } }>(resumed);
    expect(res.adopted).toBe('adopted');
    expect(res.job.worktreePath).toBe(wt);
    expect(res.job.branch).toBe('agents/cli');
    const listed = json<
      { id: string; session: { ref: string } | null; owner: { live: boolean } }[]
    >(orch(home, tmpdir(), ['--json', 'factory', 'list', '--repo', beta]));
    expect(listed[0]?.session?.ref).toBe(LINK);
    expect(listed[0]?.owner.live).toBe(true);
  });
});
