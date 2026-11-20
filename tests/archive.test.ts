/**
 * Archive: a human hides a finished job from the dashboard's default views. Only completed or
 * cancelled jobs qualify, workflow state is never touched, and every change is an event.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { allowedActions, dashboardAction } from '../src/ops/actions.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  claimJob,
  createJob,
  getJob,
  releaseJob,
  setArchived,
  transitionJob,
} from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import { seedDashboard, type SeededJobs } from './fixtures/dashboard.ts';
import { tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let ids: SeededJobs;
beforeEach(() => {
  store = tempStore();
  ids = seedDashboard(store, {
    alpha: tempDir('alpha-'),
    beta: tempDir('beta-'),
    gamma: tempDir('gamma-'),
  });
});
afterEach(() => {
  store.cleanup();
});

const types = (id: string) => listEvents(store.db, id, 100).map((e) => e.type);
const workflow = (j: Job) => ({
  stage: j.stage,
  status: j.status,
  round: j.round,
  returnStage: j.returnStage,
  completedAt: j.completedAt,
  prUrl: j.prUrl,
  prState: j.prState,
  ciStatus: j.ciStatus,
  ciHead: j.ciHead,
});

describe('setArchived (storage)', () => {
  it('archives and unarchives completed and cancelled jobs without touching workflow state', () => {
    for (const id of [ids.completed, ids.cancelled]) {
      const before = getJob(store.db, id);
      expect(before.archivedAt).toBeNull();
      const { token } = claimJob(store, id, { session: 'human', force: true });
      const archived = setArchived(store, id, { token }, true, 'old');
      expect(archived.archivedAt).not.toBeNull();
      expect(workflow(archived)).toEqual(workflow(before));
      expect(types(id).at(-1)).toBe('job.archived');
      expect(listEvents(store.db, id, 100).at(-1)?.payload).toEqual({ reason: 'old' });
      expect(() => setArchived(store, id, { token }, true)).toThrow(/already archived/);

      const back = setArchived(store, id, { token }, false);
      expect(back.archivedAt).toBeNull();
      expect(workflow(back)).toEqual(workflow(before));
      expect(types(id).at(-1)).toBe('job.unarchived');
      expect(() => setArchived(store, id, { token }, false)).toThrow(/not archived/);
      releaseJob(store, id, { token });
    }
  });

  it('needs the owner token', () => {
    expect(() => setArchived(store, ids.completed, { token: undefined }, true)).toThrow(
      OwnershipError,
    );
    expect(getJob(store.db, ids.completed).archivedAt).toBeNull();
  });
});

describe('archive through dashboardAction (ops)', () => {
  it('archives a finished job as a short dashboard episode and returns no resume command', () => {
    const before = getJob(store.db, ids.completed);
    // A session that claimed it again (to observe CI) holds a live lease: respected unless forced.
    expect(() => dashboardAction(store, ids.completed, { action: 'archive' })).toThrow(
      /live lease/,
    );
    expect(getJob(store.db, ids.completed)).toEqual(before);
    const r = dashboardAction(store, ids.completed, {
      action: 'archive',
      reason: 'done',
      force: true,
    });
    expect(r.resumeCommand).toBeUndefined();
    expect(r.job.archivedAt).not.toBeNull();
    expect(r.job.ownerSession).toBeNull(); // released
    expect(workflow(getJob(store.db, ids.completed))).toEqual(workflow(before));
    expect(types(ids.completed).slice(-3)).toEqual(['job.claimed', 'job.archived', 'job.released']);
    const u = dashboardAction(store, ids.completed, { action: 'unarchive' });
    expect(u.job.archivedAt).toBeNull();
    expect(u.resumeCommand).toBeUndefined();
    expect(types(ids.completed).slice(-2)).toEqual(['job.unarchived', 'job.released']);
    // Repeating either is refused.
    expect(() => dashboardAction(store, ids.completed, { action: 'unarchive' })).toThrow(
      ValidationError,
    );
  });

  it('refuses every non-terminal job and leaves the row unchanged', () => {
    // An interrupted job: a running job whose lease another session reclaimed.
    const interrupted = createJob(store, {
      title: 'Interrupted',
      description: 'Test request',
      repo: 'gamma',
      repoPath: '/g',
      baseBranch: 'main',
    }).id;
    const { token } = claimJob(store, interrupted, { session: 'claude-a' });
    transitionJob(store, interrupted, 'start', { token });
    claimJob(store, interrupted, { session: 'claude-b', force: true });
    expect(getJob(store.db, interrupted).status).toBe('interrupted');

    const cases = [ids.fresh, ids.reviewing, ids.stale, ids.blocked, ids.failed, interrupted];
    expect(cases.map((id) => getJob(store.db, id).status).sort()).toEqual(
      ['blocked', 'failed', 'interrupted', 'pending', 'running', 'running'].sort(),
    );
    for (const id of cases) {
      const before = getJob(store.db, id);
      for (const action of ['archive', 'unarchive'] as const) {
        // Even a forced takeover cannot archive a job that is not finished.
        expect(() => dashboardAction(store, id, { action, force: true })).toThrow(ValidationError);
      }
      expect(getJob(store.db, id)).toEqual(before);
    }
  });

  it('still refuses workflow actions on terminal jobs, archived or not', () => {
    dashboardAction(store, ids.completed, { action: 'archive', force: true });
    for (const id of [ids.completed, ids.cancelled]) {
      for (const action of ['cancel', 'approve', 'request-rework', 'request-review'] as const) {
        expect(() => dashboardAction(store, id, { action })).toThrow(/already/);
      }
    }
  });
});

describe('allowedActions', () => {
  const base = {
    stage: 'build' as const,
    round: 1,
    returnStage: null,
    prUrl: null,
    ciHead: null,
    ciStatus: null,
    prState: null,
    archivedAt: null,
    worktreePath: null,
    supersededBy: null as string | null,
  };

  it('offers remove-worktree only for a finished job with a worktree and a merged PR', () => {
    const wt = { ...base, status: 'completed' as const, worktreePath: '/wt' };
    expect(allowedActions({ ...wt, prState: 'merged' }, false)).toContain('remove-worktree');
    expect(allowedActions({ ...wt, prState: 'ready' }, false)).not.toContain('remove-worktree');
    expect(allowedActions({ ...wt, prState: 'merged', worktreePath: null }, false)).not.toContain(
      'remove-worktree',
    );
    expect(allowedActions({ ...wt, prState: 'merged', status: 'running' }, false)).not.toContain(
      'remove-worktree',
    );
  });

  it('dashboardAction refuses remove-worktree before the PR is merged, leaving the row', () => {
    const before = getJob(store.db, ids.completed);
    expect(() =>
      dashboardAction(store, ids.completed, { action: 'remove-worktree', force: true }),
    ).toThrow(/Cannot remove the worktree/);
    expect(getJob(store.db, ids.completed)).toEqual(before);
  });

  it('offers archive for a finished, unarchived job and unarchive for an archived one', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      expect(allowedActions({ ...base, status }, false)).toEqual(['archive']);
      expect(allowedActions({ ...base, status, archivedAt: '2026-11-15T00:00:00Z' }, true)).toEqual(
        ['unarchive'],
      );
    }
  });

  it('offers fix-conflicts in approve, pr, or ci, and for a completed open PR, with conflicts', () => {
    const files = { files: ['src/app.ts'], github: false };
    const github = { files: [], github: true };
    const none = { files: [], github: false };
    for (const stage of ['approve', 'pr', 'ci'] as const) {
      const job = { ...base, stage, status: 'pending' as const };
      expect(allowedActions(job, false, null, files)).toContain('fix-conflicts');
      expect(allowedActions(job, false, null, github)).toContain('fix-conflicts');
      expect(allowedActions(job, false, null, none)).not.toContain('fix-conflicts');
      expect(allowedActions(job, false, null, null)).not.toContain('fix-conflicts');
      expect(allowedActions({ ...job, status: 'cancelled' }, false, null, files)).not.toContain(
        'fix-conflicts',
      );
    }
    for (const stage of ['spec', 'build', 'review', 'needs-human'] as const) {
      expect(
        allowedActions({ ...base, stage, status: 'pending' }, false, null, files),
      ).not.toContain('fix-conflicts');
    }
    // A completed job re-lands while its PR is open and nothing superseded it yet.
    const done = { ...base, stage: 'completed' as const, status: 'completed' as const };
    for (const prState of ['draft', 'ready'] as const) {
      expect(allowedActions({ ...done, prState }, false, null, github)).toContain('fix-conflicts');
      expect(allowedActions({ ...done, prState }, false, null, null)).not.toContain(
        'fix-conflicts',
      );
      expect(
        allowedActions({ ...done, prState, supersededBy: 'job-x' }, false, null, github),
      ).not.toContain('fix-conflicts');
    }
    for (const prState of ['merged', 'closed', null] as const) {
      expect(allowedActions({ ...done, prState }, false, null, github)).not.toContain(
        'fix-conflicts',
      );
    }
    expect(
      allowedActions({ ...done, status: 'cancelled', prState: 'ready' }, false, null, github),
    ).not.toContain('fix-conflicts');
  });

  it('never offers either for a non-terminal job', () => {
    for (const status of ['pending', 'running', 'blocked', 'interrupted', 'failed'] as const) {
      const out = allowedActions({ ...base, status }, false);
      expect(out).not.toContain('archive');
      expect(out).not.toContain('unarchive');
      expect(out).toContain('cancel');
    }
  });
});
