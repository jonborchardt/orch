import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ToolError, ValidationError } from '../src/core/errors.ts';
import { jobArtifactDir } from '../src/core/paths.ts';
import { describeRepo } from '../src/git/repo.ts';
import { GH_SHIM_ENV, prWorkflowState, summarizeChecks } from '../src/integrations/github.ts';
import { ensureDraftPr, issue, prStatus, pushBranch, resolveRepo } from '../src/ops/github.ts';
import { createWorktree } from '../src/ops/worktree.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  claimJob,
  createJob,
  getJob,
  recordReview,
  registerArtifact,
  transitionJob,
} from '../src/storage/jobs.ts';
import {
  commitFile,
  gitIn,
  json,
  makeRepoWithOrigin,
  orch,
  tempDir,
  type TempStore,
  tempStore,
  writeArtifact,
} from './helpers.ts';

/**
 * A stand-in for `gh`, run as `node gh-shim.cjs <args>`. State (repo, issue, PRs, checks, a
 * command to fail, and the call log) lives in a JSON file so tests can read and change it.
 */
const SHIM = String.raw`
const fs = require('node:fs');
const file = process.env.ORCH_GH_SHIM_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const [a, b] = args;
const flag = (f) => args[args.indexOf(f) + 1];
let code = 0;
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
if (state.fail === a + ' ' + b) { process.stderr.write('shim: simulated failure'); code = 1; }
else if (a === 'repo' && b === 'view') out(state.repo);
else if (a === 'issue' && b === 'view') out(state.issue);
else if (a === 'pr' && b === 'list') out(state.prs.filter((p) => p.headRefName === flag('--head')));
else if (a === 'pr' && b === 'view') {
  const pr = state.prs.find((p) => p.url === args[2] || String(p.number) === args[2]);
  if (!pr) { process.stderr.write('no pull requests found'); code = 1; } else out(pr);
} else if (a === 'pr' && b === 'create') {
  const n = state.prs.length + 1;
  state.prs.push({
    number: n, url: 'https://github.com/acme/alpha/pull/' + n, state: 'OPEN',
    isDraft: args.includes('--draft'), baseRefName: flag('--base'), headRefName: flag('--head'),
    title: flag('--title'), mergeable: 'MERGEABLE', statusCheckRollup: state.checks,
    body: fs.readFileSync(flag('--body-file'), 'utf8'),
  });
  out('https://github.com/acme/alpha/pull/' + n + '\n');
} else { process.stderr.write('shim: unknown command ' + args.join(' ')); code = 1; }
fs.writeFileSync(file, JSON.stringify(state));
process.exit(code);
`;

interface ShimState {
  calls: string[][];
  fail?: string;
  repo: { nameWithOwner: string; url: string; defaultBranchRef: { name: string } | null };
  issue: Record<string, unknown>;
  prs: Record<string, unknown>[];
  checks: Record<string, unknown>[];
}

let shimDir: string;
let stateFile: string;
let store: TempStore;
let clone: string;
let bare: string;

function readState(): ShimState {
  return JSON.parse(readFileSync(stateFile, 'utf8')) as ShimState;
}
function writeState(patch: Partial<ShimState>): void {
  writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }));
}
function freshState(): void {
  writeFileSync(
    stateFile,
    JSON.stringify({
      calls: [],
      repo: {
        nameWithOwner: 'acme/alpha',
        url: 'https://github.com/acme/alpha',
        defaultBranchRef: { name: 'main' },
      },
      issue: {
        number: 12,
        title: 'Export CSV',
        body: 'Please',
        url: 'https://github.com/acme/alpha/issues/12',
        state: 'OPEN',
        labels: [{ name: 'feature' }],
      },
      prs: [],
      checks: [],
    } satisfies ShimState),
  );
}

beforeAll(() => {
  shimDir = tempDir('orch-gh-shim-');
  stateFile = join(shimDir, 'state.json');
  writeFileSync(join(shimDir, 'gh-shim.cjs'), SHIM);
  process.env[GH_SHIM_ENV] = join(shimDir, 'gh-shim.cjs');
  process.env['ORCH_GH_SHIM_STATE'] = stateFile;
});
afterAll(() => {
  delete process.env['ORCH_GH_SHIM'];
  delete process.env['ORCH_GH_SHIM_STATE'];
  rmSync(shimDir, { recursive: true, force: true });
});
beforeEach(() => {
  freshState();
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
  const go = (a: Parameters<typeof transitionJob>[2]) => transitionJob(store, job.id, a, { token });
  const stageWith = (artifact: string) => {
    go('start');
    writeArtifact(dir, artifact);
    registerArtifact(store, job.id, artifact, { token });
    go('complete');
  };
  if (stage === 'pr') {
    stageWith('spec.md');
    stageWith('build.md');
    go('start');
    writeArtifact(dir, 'round-1/review-security.md');
    recordReview(store, job.id, { token, reviewer: 'security', verdict: 'pass' });
    writeArtifact(dir, 'round-1/consolidated.md');
    registerArtifact(store, job.id, 'round-1/consolidated.md', { token });
    go('complete');
    stageWith('decision.md');
    go('start');
  }
  return { id: job.id, token, dir };
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
    const { id, token, dir } = jobAt('pr');
    const wt = createWorktree(store, id, { token }).job.worktreePath ?? '';
    expect(() => ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') })).toThrow(
      /Body file not found/,
    );
    writeArtifact(dir, 'pr.md');
    expect(() => ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') })).toThrow(
      /not pushed/,
    );

    commitFile(wt, 'export.ts', 'export const csv = 1;');
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

    // A new local commit that is not pushed blocks PR work until pushed.
    commitFile(wt, 'more.ts', 'x');
    expect(() => ensureDraftPr(store, id, { token, bodyFile: join(dir, 'pr.md') })).toThrow(
      /push first/,
    );
    pushBranch(store, id, { token });

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
    registerArtifact(store, id, 'pr.md', { token });
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
    const wt = createWorktree(store, id, { token }).job.worktreePath ?? '';
    commitFile(wt, 'f.ts', 'f');
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
      const env = { [GH_SHIM_ENV]: join(shimDir, 'gh-shim.cjs'), ORCH_GH_SHIM_STATE: stateFile };
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
      const noGh = orch(home, clone, ['gh', 'repo'], { [GH_SHIM_ENV]: '', PATH: '' });
      expect(noGh.code).toBe(1);
      expect(noGh.err).toMatch(/gh\) not found|not inside a Git repository|git/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
