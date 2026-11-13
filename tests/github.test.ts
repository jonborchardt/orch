import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ToolError, ValidationError } from '../src/core/errors.ts';
import { jobArtifactDir } from '../src/core/paths.ts';
import { describeRepo } from '../src/git/repo.ts';
import { prWorkflowState, summarizeChecks } from '../src/integrations/github.ts';
import { addArtifact, recordVerdict, transitionGuarded } from '../src/ops/gates.ts';
import { ensureDraftPr, issue, prStatus, pushBranch, resolveRepo } from '../src/ops/github.ts';
import { createWorktree } from '../src/ops/worktree.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import {
  commitFile,
  type GhShim,
  ghShim,
  gitIn,
  json,
  makeRepoWithOrigin,
  orch,
  type ShimState,
  tempDir,
  type TempStore,
  tempStore,
  writeArtifact,
} from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
let shim: GhShim;
const readState = () => shim.read();
const writeState = (patch: Partial<ShimState>) => {
  shim.write(patch);
};

beforeAll(() => {
  shim = ghShim();
  Object.assign(process.env, shim.env);
});
afterAll(() => {
  delete process.env['ORCH_GH_SHIM'];
  delete process.env['ORCH_GH_SHIM_STATE'];
  shim.cleanup();
});
beforeEach(() => {
  shim.reset();
  store = tempStore();
  ({ clone, bare } = makeRepoWithOrigin('git@github.com:acme/alpha.git'));
});
afterEach(() => {
  store.cleanup();
  rmSync(clone, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

/** Create, claim, and drive a job to the given stage with valid fixture artifacts. */
function jobAt(stage: 'spec' | 'pr') {
  const repo = describeRepo(clone);
  const job = createJob(store, {
    title: 'Export CSV',
    repo: repo.identity,
    repoPath: repo.root,
    baseBranch: 'main',
  });
  const { token } = claimJob(store, job.id, { session: 's1' });
  const dir = jobArtifactDir(job.id, store.paths);
  // The worktree exists from the start, as `orch factory start` guarantees.
  const wt = createWorktree(store, job.id, { token }).job.worktreePath ?? '';
  const go = (a: Parameters<typeof transitionJob>[2]) =>
    transitionGuarded(store, job.id, a, { token });
  const stageWith = (artifact: string) => {
    go('start');
    writeArtifact(dir, artifact);
    addArtifact(store, job.id, artifact, { token });
    go('complete');
  };
  if (stage === 'pr') {
    stageWith('spec.md');
    commitFile(wt, 'export.ts', 'export const csv = 1;');
    stageWith('build.md');
    go('start');
    writeArtifact(dir, 'round-1/review-security.md');
    recordVerdict(store, job.id, { token, reviewer: 'security', verdict: 'pass' });
    writeArtifact(dir, 'round-1/consolidated.md');
    addArtifact(store, job.id, 'round-1/consolidated.md', { token });
    go('complete');
    stageWith('decision.md');
    go('start');
  }
  return { id: job.id, token, dir, wt };
}

describe('gh wrapper', () => {
  it('summarizes check rollups and maps PR states', () => {
    expect(summarizeChecks([])).toBe('none');
    expect(summarizeChecks([{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe(
      'passing',
    );
    expect(summarizeChecks([{ name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe(
      'passing',
    );
    expect(
      summarizeChecks([
        { name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'b', status: 'IN_PROGRESS', conclusion: '' },
      ]),
    ).toBe('pending');
    expect(
      summarizeChecks([
        { name: 'a', status: 'QUEUED', conclusion: '' },
        { name: 'b', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failing');
    expect(summarizeChecks([{ name: 's', status: 'PENDING', conclusion: 'PENDING' }])).toBe(
      'pending',
    );
    expect(prWorkflowState({ state: 'OPEN', isDraft: true })).toBe('draft');
    expect(prWorkflowState({ state: 'OPEN', isDraft: false })).toBe('ready');
    expect(prWorkflowState({ state: 'MERGED', isDraft: false })).toBe('merged');
    expect(prWorkflowState({ state: 'CLOSED', isDraft: false })).toBeUndefined();
  });

  it('resolves the repository and refuses a mismatch; failures carry gh stderr', () => {
    const repo = describeRepo(clone);
    const r = resolveRepo({ repo: repo.identity, repoPath: clone });
    expect(r.identity).toBe('github.com/acme/alpha');
    expect(r.defaultBranch).toBe('main');
    expect(() => resolveRepo({ repo: 'github.com/acme/beta', repoPath: clone })).toThrow(
      /GitHub reports github.com\/acme\/alpha/,
    );
    writeState({ fail: 'repo view' });
    expect(() => resolveRepo({ repo: repo.identity, repoPath: clone })).toThrow(
      /simulated failure/,
    );
  });

  it("issue accepts #N, N, and URLs, scoped to the checkout's repository", () => {
    expect(issue('#12', clone).title).toBe('Export CSV');
    expect(issue('12', clone).labels).toEqual(['feature']);
    expect(issue('https://github.com/acme/alpha/issues/12', clone).number).toBe(12);
    const call = readState().calls.at(-1) ?? [];
    expect(call.slice(0, 3)).toEqual(['issue', 'view', 'https://github.com/acme/alpha/issues/12']);
    expect(call).toContain('acme/alpha');
    expect(() => issue('twelve', clone)).toThrow(ToolError);
    expect(() => issue('https://evil.example/x', clone)).toThrow(/Not an issue reference/);
  });
});

describe('push and draft PR delivery', () => {
  it('pushes once, creates one draft PR, reuses it, and records CI status', () => {
    const { id, token, dir, wt } = jobAt('pr');
    expect(() => ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') })).toThrow(
      /Body file not found/,
    );
    writeArtifact(dir, 'pr.md');
    expect(() => ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') })).toThrow(
      /not pushed/,
    );

    const pushed = pushBranch(store, id, { token });
    expect(pushed.pushed).toBe(true);
    expect(gitIn(bare, 'rev-parse', `refs/heads/${pushed.branch}`)).toBe(pushed.head);
    expect(pushBranch(store, id, { token }).pushed).toBe(false);
    expect(listEvents(store.db, id).filter((e) => e.type === 'branch.pushed')).toHaveLength(1);

    const created = ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') });
    expect(created.created).toBe(true);
    expect(created.pr.isDraft).toBe(true);
    expect(created.pr.baseRefName).toBe('main');
    expect(created.pr.headRefName).toBe(pushed.branch);
    expect(created.job.prUrl).toBe('https://github.com/acme/alpha/pull/1');
    expect(created.job.prState).toBe('draft');
    expect(created.ciStatus).toBe('none');
    expect(created.job.ciStatus).toBe('none');
    const createCalls = () => readState().calls.filter((c) => c[0] === 'pr' && c[1] === 'create');
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0]).toContain('--draft');
    expect(createCalls()[0]).not.toContain('--web');

    const reused = ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') });
    expect(reused.created).toBe(false);
    expect(reused.pr.url).toBe(created.pr.url);
    expect(createCalls()).toHaveLength(1);

    // A commit made after the approval is neither pushed nor attached to the PR.
    commitFile(wt, 'more.ts', 'x');
    expect(() => pushBranch(store, id, { token })).toThrow(/not approved/);
    expect(() => ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') })).toThrow(
      /not approved/,
    );
    gitIn(wt, 'reset', '-q', '--hard', 'HEAD~1'); // test only: drop the unapproved commit
    expect(pushBranch(store, id, { token }).pushed).toBe(false);

    // CI observation: read-only without a token, recorded with one.
    const st = readState();
    st.prs[0] = {
      ...st.prs[0],
      statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
    };
    writeState({ prs: st.prs });
    const ro = prStatus(store, id);
    expect(ro.recorded).toBe(false);
    expect(ro.ciStatus).toBe('failing');
    expect(getJob(store.db, id).ciStatus).toBe('none');
    const rw = prStatus(store, id, { token });
    expect(rw.recorded).toBe(true);
    expect(rw.job.ciStatus).toBe('failing');
    expect(rw.job.ciCheckedAt).toBeTruthy();

    // The workflow still finishes only through the normal transition with pr.md registered.
    addArtifact(store, id, 'pr.md', { token });
    const done = transitionJob(store, id, 'complete', { token });
    expect(done.stage).toBe('completed');
    // A later observation that the PR was marked ready is recorded without changing the stage.
    const st2 = readState();
    st2.prs[0] = { ...st2.prs[0], isDraft: false };
    writeState({ prs: st2.prs });
    expect(prStatus(store, id, { token }).job.prState).toBe('ready');
  });

  it('refuses PR creation outside the pr stage, on a mismatched repo, or a missing base', () => {
    const early = jobAt('spec');
    writeArtifact(early.dir, 'pr.md');
    createWorktree(store, early.id, { token: early.token });
    expect(() =>
      ensureDraftPr(store, early.id, { token: early.token, bodyFile: join(early.dir, 'pr.md') }),
    ).toThrow(/only be created in the pr stage/);

    const { id, token, dir } = jobAt('pr');
    writeArtifact(dir, 'pr.md');
    pushBranch(store, id, { token });
    writeState({
      repo: {
        nameWithOwner: 'acme/beta',
        url: 'https://github.com/acme/beta',
        defaultBranchRef: null,
      },
    });
    expect(() => ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') })).toThrow(
      /GitHub reports github.com\/acme\/beta/,
    );
    expect(readState().calls.some((c) => c[1] === 'create')).toBe(false);
    expect(getJob(store.db, id).prUrl).toBeNull();
  });

  it('push requires ownership and the job branch to be checked out', () => {
    const { id, token } = jobAt('pr');
    const wt = createWorktree(store, id, { token }).job.worktreePath ?? '';
    expect(() => pushBranch(store, id, { token: 'bad' })).toThrow(/Stale or invalid token/);
    gitIn(wt, 'checkout', '-q', '-b', 'detour');
    expect(() => pushBranch(store, id, { token })).toThrow(ValidationError);
    expect(() => pushBranch(store, id, { token })).toThrow(/refusing to push/);
  });

  it('is available on the CLI: orch gh repo / issue / pr status with --json', () => {
    const home = tempDir('orch-gh-cli-');
    try {
      const env = shim.env;
      const repo = json<{ identity: string }>(orch(home, clone, ['--json', 'gh', 'repo'], env));
      expect(repo.identity).toBe('github.com/acme/alpha');
      const iss = json<{ number: number }>(
        orch(home, clone, ['--json', 'gh', 'issue', '#12'], env),
      );
      expect(iss.number).toBe(12);
      expect(orch(home, tmpdir(), ['gh']).code).toBe(2);
      expect(orch(home, tmpdir(), ['gh', 'pr', 'nope', 'job-x']).code).toBe(2);
      expect(orch(home, tmpdir(), ['gh', 'pr', 'status', 'job-x'], env).code).toBe(3);
      const created = json<{ jobId: string }>(
        orch(home, clone, ['--json', 'job', 'create', '--title', 'cli'], env),
      );
      const st = orch(home, tmpdir(), ['gh', 'pr', 'status', created.jobId], env);
      expect(st.code).toBe(1);
      expect(st.err).toContain('no PR recorded');
      // Without gh and without the shim, the error is explicit.
      const noGh = orch(home, clone, ['gh', 'repo'], { ORCH_GH_SHIM: '', PATH: '' });
      expect(noGh.code).toBe(1);
      expect(noGh.err).toMatch(/gh\) not found|not inside a Git repository|git/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
