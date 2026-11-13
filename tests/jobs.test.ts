import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NotFoundError,
  OwnershipError,
  ValidationError,
  WorkflowError,
} from '../src/core/errors.ts';
import { jobArtifactDir } from '../src/core/paths.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  claimJob,
  createJob,
  getJob,
  jobDetail,
  listJobs,
  recordPr,
  recordReview,
  registerArtifact,
  releaseJob,
  resumeJob,
  transitionJob,
} from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import { fixture, type TempStore, tempStore, writeArtifact } from './helpers.ts';

const input = (title = 'T', repo = 'github.com/o/r') => ({
  title,
  repo,
  repoPath: '/r',
  baseBranch: 'main',
});

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create, claim, and return the token plus the artifact dir. */
function setup(extra: Partial<Parameters<typeof createJob>[1]> = {}) {
  const job = createJob(store, { ...input(), ...extra });
  const { token } = claimJob(store, job.id, { session: 's1' });
  return { id: job.id, token, dir: jobArtifactDir(job.id, store.paths) };
}

function go(id: string, token: string, action: Parameters<typeof transitionJob>[2]): Job {
  return transitionJob(store, id, action, { token });
}

describe('jobs: create, read, list', () => {
  it('assigns unique ids, defaults, and an artifact directory', () => {
    const a = createJob(store, input('a'));
    const b = createJob(store, input('b'));
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^job-[0-9a-f]{8}$/);
    expect([a.stage, a.status, a.round, a.maxRounds, a.revision]).toEqual([
      'spec',
      'pending',
      0,
      3,
      1,
    ]);
    expect(existsSync(jobArtifactDir(a.id, store.paths))).toBe(true);
    expect(listEvents(store.db, a.id).map((e) => e.type)).toEqual(['job.created']);
  });

  it('throws NotFoundError for unknown ids', () => {
    expect(() => getJob(store.db, 'job-nope')).toThrow(NotFoundError);
    expect(() => jobDetail(store, 'job-nope')).toThrow(/No job with id job-nope/);
  });

  it('lists newest first and filters by repo, status, stage', () => {
    createJob(store, input('one', 'github.com/o/a'));
    const two = createJob(store, input('two', 'github.com/o/b'));
    claimJob(store, two.id, { session: 's' });
    expect(listJobs(store.db).map((j) => j.title)).toEqual(['two', 'one']);
    expect(listJobs(store.db, { repo: 'github.com/o/a' }).map((j) => j.title)).toEqual(['one']);
    expect(listJobs(store.db, { status: 'pending' })).toHaveLength(2);
    expect(listJobs(store.db, { stage: 'build' })).toHaveLength(0);
  });
});

describe('jobs: ownership', () => {
  it('claim is atomic; a second session is rejected while the lease is live', () => {
    const job = createJob(store, input());
    const first = claimJob(store, job.id, { session: 's1' });
    expect(first.job.ownerSession).toBe('s1');
    expect(() => claimJob(store, job.id, { session: 's2' })).toThrow(OwnershipError);
    // Same session renews with a fresh token; the earlier handle stops working, so two
    // processes resuming under one session name cannot both keep driving the job.
    const renewed = claimJob(store, job.id, { session: 's1' });
    expect(renewed.token).not.toBe(first.token);
    expect(() => go(job.id, first.token, 'start')).toThrow(/Stale or invalid token/);
    // Force takes over with a new token.
    const forced = claimJob(store, job.id, { session: 's2', force: true });
    expect(forced.token).not.toBe(renewed.token);
    expect(() => go(job.id, renewed.token, 'start')).toThrow(/Stale or invalid token/);
  });

  it('release clears ownership; mutations then require a fresh claim', () => {
    const { id, token } = setup();
    const released = releaseJob(store, id, { token });
    expect(released.ownerSession).toBeNull();
    expect(() => go(id, token, 'start')).toThrow(/not claimed/);
    expect(listEvents(store.db, id).map((e) => e.type)).toContain('job.released');
  });

  it('expired leases can be reclaimed; a running job becomes interrupted', async () => {
    const job = createJob(store, input());
    const { token } = claimJob(store, job.id, { session: 's1', leaseMinutes: 0 });
    go(job.id, token, 'start');
    await sleep(5);
    const taken = claimJob(store, job.id, { session: 's2' });
    expect(taken.job.status).toBe('interrupted');
    expect(taken.job.ownerSession).toBe('s2');
    expect(() => go(job.id, token, 'complete')).toThrow(OwnershipError);
    const types = listEvents(store.db, job.id).map((e) => e.type);
    expect(types).toContain('job.interrupted');
  });

  it('resume adopts an interrupted job and returns it to pending with full detail', async () => {
    const job = createJob(store, input());
    const { token } = claimJob(store, job.id, { session: 's1', leaseMinutes: 0 });
    go(job.id, token, 'start');
    writeArtifact(jobArtifactDir(job.id, store.paths), 'spec.md');
    registerArtifact(store, job.id, 'spec.md', { token });
    await sleep(5);
    const r = resumeJob(store, job.id, { session: 's2' });
    expect(r.detail.job.status).toBe('pending');
    expect(r.detail.job.stage).toBe('spec');
    expect(r.detail.artifacts.map((a) => a.path)).toEqual(['spec.md']);
    // The new owner can continue; completed-stage artifacts were preserved.
    go(job.id, r.token, 'start');
    expect(go(job.id, r.token, 'complete').stage).toBe('build');
  });

  it('resume on a healthy owned job just renews the claim', () => {
    const { id } = setup();
    const r = resumeJob(store, id, { session: 's1' });
    expect(r.detail.job.status).toBe('pending');
    expect(listEvents(store.db, id).filter((e) => e.type === 'job.resumed')).toHaveLength(0);
  });

  it('every owner mutation renews the lease and bumps the revision', () => {
    const { id, token } = setup();
    const before = getJob(store.db, id);
    const after = go(id, token, 'start');
    expect(after.revision).toBe(before.revision + 1);
    expect((after.leaseExpiresAt ?? '') >= (before.leaseExpiresAt ?? 'z')).toBe(true);
  });

  it('rejects stale revisions (optimistic concurrency)', () => {
    const { id, token } = setup();
    const job = getJob(store.db, id);
    go(id, token, 'start');
    expect(() => transitionJob(store, id, 'fail', { token, expectRevision: job.revision })).toThrow(
      /Stale revision/,
    );
    expect(
      transitionJob(store, id, 'fail', { token, expectRevision: job.revision + 1 }).status,
    ).toBe('failed');
  });
});

describe('jobs: artifacts', () => {
  it('validates location, type, existence, and emptiness', () => {
    const { id, token, dir } = setup();
    expect(() => registerArtifact(store, id, '../escape.md', { token })).toThrow(/inside/);
    expect(() => registerArtifact(store, id, 'spec.txt', { token })).toThrow(/\.md/);
    expect(() => registerArtifact(store, id, 'spec.md', { token })).toThrow(/not found/);
    writeArtifact(dir, 'spec.md', '');
    expect(() => registerArtifact(store, id, 'spec.md', { token })).toThrow(/empty/);
    writeArtifact(dir, 'spec.md', '# Spec\n\n## Goal\nonly a goal\n');
    expect(() => registerArtifact(store, id, 'spec.md', { token })).toThrow(
      /missing required section\(s\): "Scope", "Acceptance criteria"/,
    );
    writeArtifact(dir, 'spec.md');
    const a = registerArtifact(store, id, 'spec.md', { token });
    expect(a.path).toBe('spec.md');
    expect(a.stage).toBe('spec');
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Re-registering identical content is idempotent.
    expect(registerArtifact(store, id, 'spec.md', { token }).id).toBe(a.id);
    expect(jobDetail(store, id).artifacts).toHaveLength(1);
    // Changed content needs an explicit --replace and is recorded as a replacement.
    writeArtifact(dir, 'spec.md', fixture('spec.md') + '\nmore\n');
    expect(() => registerArtifact(store, id, 'spec.md', { token })).toThrow(/--replace/);
    const b = registerArtifact(store, id, 'spec.md', { token, replace: true });
    expect(b.id).toBe(a.id);
    expect(b.sha256).not.toBe(a.sha256);
    const types = listEvents(store.db, id).map((e) => e.type);
    expect(types.filter((t) => t === 'artifact.replaced')).toHaveLength(1);
    expect(jobDetail(store, id).artifacts).toHaveLength(1);
  });

  it('rejects absolute paths and traversal from nested directories', () => {
    const { id, token, dir } = setup();
    writeArtifact(dir, 'spec.md');
    expect(() => registerArtifact(store, id, join(dir, 'spec.md'), { token })).toThrow(/relative/);
    expect(() => registerArtifact(store, id, 'round-1/../../x.md', { token })).toThrow(/inside/);
  });

  it('review and decision files must carry their marker lines', () => {
    const { id, token, dir } = setup();
    writeArtifact(dir, 'decision.md', '# D\n\n## Rationale\nr\n');
    expect(() => registerArtifact(store, id, 'decision.md', { token })).toThrow(/DECISION/);
    writeArtifact(dir, 'decision.md', '# D\n\n## Rationale\nr\n\nDECISION: MAYBE\n');
    expect(() => registerArtifact(store, id, 'decision.md', { token })).toThrow(/one of APPROVE/);
    // A well-formed decision is still refused outside the approve stage.
    writeArtifact(dir, 'decision.md', fixture('decision.md', 'ESCALATE'));
    expect(() => registerArtifact(store, id, 'decision.md', { token })).toThrow(
      /belongs to the approve stage/,
    );
    writeArtifact(dir, 'round-1/consolidated.md', fixture('round-1/consolidated.md', 'many'));
    expect(() => registerArtifact(store, id, 'round-1/consolidated.md', { token })).toThrow(
      /BLOCKING must match/,
    );
    writeArtifact(dir, 'notes/evidence.md', 'free-form evidence\n');
    expect(registerArtifact(store, id, 'notes/evidence.md', { token }).marker).toBeNull();
  });

  it('normalizes nested paths to forward slashes', () => {
    const { id, token, dir } = setup();
    writeArtifact(dir, 'notes/evidence.md', 'free-form\n');
    const a = registerArtifact(store, id, 'notes\\evidence.md', { token });
    expect(a.path).toBe('notes/evidence.md');
  });
});

describe('jobs: full workflow through storage', () => {
  function advance(id: string, token: string, dir: string, artifact: string): Job {
    go(id, token, 'start');
    writeArtifact(dir, artifact);
    registerArtifact(store, id, artifact, { token });
    return go(id, token, 'complete');
  }

  it('runs spec -> build -> review (changes) -> build -> review (pass) -> approve -> pr -> done', () => {
    const { id, token, dir } = setup();
    expect(advance(id, token, dir, 'spec.md').stage).toBe('build');
    expect(() => go(id, token, 'complete')).toThrow(WorkflowError); // not running
    expect(advance(id, token, dir, 'build.md').stage).toBe('review');

    // Round 1: reviews can only be recorded while review is running.
    expect(() => recordReview(store, id, { token, reviewer: 'code' })).toThrow(ValidationError);
    go(id, token, 'start');
    recordReview(store, id, { token, reviewer: 'code' });
    recordReview(store, id, { token, reviewer: 'security' });
    writeArtifact(dir, 'round-1/consolidated.md');
    registerArtifact(store, id, 'round-1/consolidated.md', { token });
    expect(() => go(id, token, 'complete')).toThrow(/pending: code, security/);
    writeArtifact(dir, 'round-1/review-code.md', fixture('round-1/review-code.md', 'CHANGES'));
    writeArtifact(dir, 'round-1/review-security.md');
    // The recorded verdict must agree with the file's VERDICT line.
    expect(() =>
      recordReview(store, id, { token, reviewer: 'code', verdict: 'pass', summary: 'nit' }),
    ).toThrow(/does not match/);
    recordReview(store, id, { token, reviewer: 'code', verdict: 'changes', summary: 'nit' });
    recordReview(store, id, { token, reviewer: 'security', verdict: 'pass' });
    const back = go(id, token, 'complete');
    expect([back.stage, back.status, back.round]).toEqual(['build', 'pending', 1]);

    // Round 2 passes.
    expect(advance(id, token, dir, 'build.md').round).toBe(2);
    go(id, token, 'start');
    writeArtifact(dir, 'round-2/review-code.md');
    recordReview(store, id, { token, reviewer: 'code', verdict: 'pass' });
    writeArtifact(dir, 'round-2/consolidated.md');
    registerArtifact(store, id, 'round-2/consolidated.md', { token });
    expect(go(id, token, 'complete').stage).toBe('approve');
    expect(advance(id, token, dir, 'decision.md').stage).toBe('pr');

    // PR stage: record a draft PR before completing.
    expect(() => recordPr(store, id, { token, url: 'nope', state: 'draft' })).toThrow(/http/);
    go(id, token, 'start');
    writeArtifact(dir, 'pr.md');
    registerArtifact(store, id, 'pr.md', { token });
    expect(() => go(id, token, 'complete')).toThrow(/record the PR/);
    const pr = recordPr(store, id, { token, url: 'https://github.com/o/r/pull/7', state: 'draft' });
    expect(pr.prState).toBe('draft');
    const done = go(id, token, 'complete');
    expect([done.stage, done.status]).toEqual(['completed', 'completed']);
    expect(done.completedAt).toBeTruthy();
    // PR state can still be updated after completion (ready, merged); nothing else can.
    expect(recordPr(store, id, { token, url: pr.prUrl ?? '', state: 'ready' }).prState).toBe(
      'ready',
    );
    expect(() => go(id, token, 'start')).toThrow(/finished/);

    const detail = jobDetail(store, id, 1000);
    expect(detail.reviews).toHaveLength(3);
    expect(detail.artifacts.map((a) => a.path).sort()).toEqual([
      'build.md',
      'decision.md',
      'pr.md',
      'round-1/consolidated.md',
      'round-1/review-code.md',
      'round-1/review-security.md',
      'round-2/consolidated.md',
      'round-2/review-code.md',
      'spec.md',
    ]);
    const types = detail.events.map((e) => e.type);
    expect(types[0]).toBe('job.created');
    expect(types.at(-1)).toBe('pr.recorded');
    expect(types).toContain('job.completed');
    expect(detail.events.slice(1).every((e) => e.actor === 's1')).toBe(true);
  });

  it('escalates when the maximum round still requests changes, then resumes to build', () => {
    const { id, token, dir } = setup({ maxRounds: 1 });
    advance(id, token, dir, 'spec.md');
    advance(id, token, dir, 'build.md');
    go(id, token, 'start');
    writeArtifact(dir, 'round-1/review-code.md', fixture('round-1/review-code.md', 'CHANGES'));
    recordReview(store, id, { token, reviewer: 'code', verdict: 'changes' });
    writeArtifact(dir, 'round-1/consolidated.md', fixture('round-1/consolidated.md', '2'));
    registerArtifact(store, id, 'round-1/consolidated.md', { token });
    const blocked = go(id, token, 'complete');
    expect([blocked.stage, blocked.status, blocked.returnStage]).toEqual([
      'needs-human',
      'blocked',
      'build',
    ]);
    expect(() => go(id, token, 'start')).toThrow(/--to/);
    const resumed = go(id, token, 'resume');
    expect([resumed.stage, resumed.status]).toEqual(['build', 'pending']);
  });

  it('escalate, cancel, and duplicate commands', () => {
    const { id, token } = setup();
    go(id, token, 'start');
    expect(() => go(id, token, 'start')).toThrow(/not startable/);
    const esc = transitionJob(store, id, 'escalate', { token, reason: 'ambiguous' });
    expect(esc.stage).toBe('needs-human');
    const resumed = transitionJob(store, id, 'resume', { token, to: 'spec' });
    expect(resumed.stage).toBe('spec');
    const cancelled = transitionJob(store, id, 'cancel', { token, reason: 'nvm' });
    expect(cancelled.status).toBe('cancelled');
    expect(() => go(id, token, 'cancel')).toThrow(/already cancelled/);
    expect(() => go(id, token, 'start')).toThrow(/finished/);
  });

  it('rejects malformed reviews and PRs outside the pr stage', () => {
    const { id, token } = setup();
    expect(() => recordReview(store, id, { token, reviewer: 'Bad Name' })).toThrow(ValidationError);
    expect(() =>
      recordReview(store, id, { token, reviewer: 'code', verdict: 'maybe' as never }),
    ).toThrow(/Verdict/);
    expect(() => recordPr(store, id, { token, url: 'https://x/1', state: 'draft' })).toThrow(
      /pr stage/,
    );
  });
});
