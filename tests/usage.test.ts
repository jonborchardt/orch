/**
 * `orch job usage`: measured time per stage visit, per reviewer run, verification, and CI, with
 * the configured models; token counts are reported as not measured, never estimated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import { jobUsage } from '../src/ops/usage.ts';
import {
  claimJob,
  createJob,
  recordReview,
  registerArtifact,
  transitionJob,
} from '../src/storage/jobs.ts';
import { json, orch, type TempStore, tempStore, writeArtifact } from './helpers.ts';

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

describe('jobUsage', () => {
  it('derives stage visits, reviewer runs, and CI counters from the records; tokens are unmeasured', () => {
    const job = createJob(store, {
      title: 'Export CSV',
      description: 'Test request',
      repo: 'github.com/acme/alpha',
      repoPath: '/repos/alpha',
      baseBranch: 'main',
    });
    const { token } = claimJob(store, job.id, { session: 's1' });
    const dir = jobArtifactDir(job.id, store.paths);
    const go = (a: Parameters<typeof transitionJob>[2]) =>
      transitionJob(store, job.id, a, { token });
    const art = (rel: string) => {
      writeArtifact(dir, rel);
      registerArtifact(store, job.id, rel, { token });
    };
    go('start');
    art('spec.md');
    art('spec-review-1.md');
    go('complete');
    go('start');
    art('build.md');
    go('complete');
    go('start');
    art('round-1/simplify-review.md');
    art('round-1/simplify.md');
    go('complete');
    go('start');
    for (const r of ['security', 'correctness', 'code-quality']) {
      recordReview(store, job.id, { token, reviewer: r }); // launched, no verdict yet
    }
    for (const r of ['security', 'correctness']) {
      writeArtifact(dir, `round-1/review-${r}.md`);
      recordReview(store, job.id, { token, reviewer: r, verdict: 'pass' });
    }

    const u = jobUsage(store, job.id);
    expect(u.jobId).toBe(job.id);
    expect(u.wallMs).toBeGreaterThanOrEqual(0);
    expect(u.stages.map((v) => [v.stage, v.round, v.endedBy])).toEqual([
      ['spec', 0, 'stage.completed'],
      ['build', 0, 'stage.completed'],
      ['simplify', 1, 'stage.completed'],
      ['review', 1, null],
    ]);
    expect(u.stages[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(u.stages[3]?.durationMs).toBeNull();
    expect(Object.keys(u.stageMs).sort()).toEqual(['build', 'simplify', 'spec']);
    expect(u.reviews.map((r) => [r.reviewer, r.verdict, r.durationMs === null])).toEqual([
      ['security', 'pass', false],
      ['correctness', 'pass', false],
      ['code-quality', null, true],
    ]);
    expect(u.reviews[0]?.configuredModel).toBe('opus');
    expect(u.reviews[1]?.configuredModel).toBe('sonnet');
    expect(u.models['builder']).toBe('opus');
    expect(u.verification).toEqual({ runs: 0, checks: 0, totalMs: 0 });
    expect(u.ci).toEqual({ repairs: 0, reruns: 0, observations: 0 });
    expect(u.tokens.measured).toBe(false);
    expect(u.tokens.reason).toContain('not expose');
    expect(u.tokens.reason).toContain('dashboard Usage section');

    // A stage that fails, is escalated, or reworked closes its visit with that event.
    go('fail');
    expect(jobUsage(store, job.id).stages.at(-1)).toMatchObject({
      stage: 'review',
      endedBy: 'stage.failed',
    });
    // The CLI prints the same report.
    const cli = json<{ stages: unknown[]; tokens: { measured: boolean; reason: string } }>(
      orch(store.home, store.home, ['--json', 'job', 'usage', job.id]),
    );
    expect(cli.stages).toHaveLength(4);
    expect(cli.tokens.measured).toBe(false);
    expect(cli.tokens.reason).toContain('dashboard Usage section');
    expect(orch(store.home, store.home, ['job', 'usage']).code).toBe(2);
    expect(orch(store.home, store.home, ['job', 'usage', 'job-00000000']).code).toBe(3);
  });
});
