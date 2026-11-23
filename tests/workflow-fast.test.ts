/**
 * Fast mode in the pure transition (decision 2026-11-23-fast-mode): build -> pr -> ci ->
 * completed, build.md as the approval, and resume limited to the stages a fast job visits.
 */
import { describe, expect, it } from 'vitest';

import {
  type Action,
  approvalEvidence,
  type Stage,
  type Status,
  transition,
  type TransitionContext,
} from '../src/core/workflow.ts';
import type { Artifact } from '../src/storage/schema.ts';

type JobState = Parameters<typeof transition>[0];

function job(stage: Stage, status: Status, extra: Partial<JobState> = {}): JobState {
  return {
    stage,
    status,
    round: 0,
    maxRounds: 3,
    returnStage: null,
    prUrl: null,
    prState: null,
    ciStatus: null,
    ciHead: null,
    ciRepairs: 0,
    maxCiRepairs: 2,
    scopeReworks: 0,
    startedAt: null,
    mode: 'fast',
    ...extra,
  };
}

function art(path: string, marker: string | null = null, head: string | null = 'abc'): Artifact {
  return {
    id: 1,
    jobId: 'j',
    stage: 'build',
    round: null,
    path,
    bytes: 1,
    sha256: null,
    marker,
    head,
    specSha256: null,
    createdAt: '',
  };
}

const ctx = (artifacts: Artifact[], extra: Partial<TransitionContext> = {}): TransitionContext => ({
  artifacts,
  reviews: [],
  ...extra,
});
const run = (j: JobState, action: Action, c = ctx([])) => transition(j, action, c);
const built = [art('build.md')];
const delivered = [art('build.md'), art('pr.md')];
const ciJob = (extra: Partial<JobState> = {}) =>
  job('ci', 'running', {
    prUrl: 'https://x/pr/1',
    prState: 'draft',
    ciStatus: 'passing',
    ciHead: 'abc',
    ...extra,
  });

describe('approvalEvidence', () => {
  it('full: decision.md only when it says APPROVE', () => {
    expect(approvalEvidence('full', [art('decision.md', 'approve')])?.path).toBe('decision.md');
    expect(approvalEvidence('full', [art('decision.md', 'escalate')])).toBeUndefined();
    expect(approvalEvidence('full', [])).toBeUndefined();
    // build.md is never a full job's approval.
    expect(approvalEvidence('full', built)).toBeUndefined();
  });

  it('fast: build.md, whose head is the approved head; decision.md never counts', () => {
    expect(approvalEvidence('fast', [art('build.md', null, 'f00')])?.head).toBe('f00');
    // Recorded without a head: there is no approved head (requireApproved refuses it).
    expect(approvalEvidence('fast', [art('build.md', null, null)])?.head ?? null).toBeNull();
    expect(approvalEvidence('fast', [art('decision.md', 'approve')])).toBeUndefined();
    expect(approvalEvidence('fast', [])).toBeUndefined();
  });
});

describe('the fast route', () => {
  it('build complete goes to pr in the same round', () => {
    const r = run(job('build', 'running'), 'complete', ctx(built));
    expect(r.patch).toEqual({ stage: 'pr', status: 'pending' });
  });

  it('pr complete needs build.md, not decision.md, under either authority', () => {
    const pr = job('pr', 'running', { prUrl: 'https://x/pr/1' });
    for (const authority of ['local', 'ci'] as const) {
      expect(run(pr, 'complete', ctx(delivered, { authority })).patch.stage).toBe('ci');
      expect(() => run(pr, 'complete', ctx([art('pr.md')], { authority }))).toThrow(
        /no build\.md is registered/,
      );
    }
  });

  it('ci complete with a passing verdict completes the job under ci and under local', () => {
    for (const authority of ['ci', 'local'] as const) {
      const r = run(ciJob(), 'complete', ctx(delivered, { authority }));
      expect(r.patch).toMatchObject({ stage: 'completed', status: 'completed' });
      expect(r.events.map((e) => e.type)).toEqual(['stage.completed', 'job.completed']);
    }
  });

  it('a full job under ci without an approval still takes the pre-review pass', () => {
    const r = run(ciJob({ mode: 'full' }), 'complete', ctx([], { authority: 'ci' }));
    expect(r.patch.stage).toBe('review');
  });

  it('rework from pr and ci goes to build; spent CI repairs go to needs-human', () => {
    const pr = job('pr', 'running', { prUrl: 'https://x/pr/1' });
    expect(run(pr, 'rework', ctx(delivered)).patch.stage).toBe('build');
    expect(run(ciJob(), 'rework', ctx(delivered)).patch).toMatchObject({
      stage: 'build',
      ciRepairs: 1,
    });
    const spent = run(ciJob({ ciRepairs: 2 }), 'rework', ctx(delivered));
    expect(spent.patch).toMatchObject({ stage: 'needs-human', returnStage: 'build' });
    expect(spent.events[0]?.payload['reason']).toBe('max CI repair cycles reached');
  });

  it('escalate from build goes to needs-human with the reason', () => {
    const r = transition(job('build', 'running'), 'escalate', ctx([], { reason: 'too broad' }));
    expect(r.patch).toEqual({ stage: 'needs-human', status: 'blocked', returnStage: 'build' });
    expect(r.events[0]?.payload).toEqual({ from: 'build', reason: 'too broad' });
  });
});

describe('resume of a fast job', () => {
  const blocked = job('needs-human', 'blocked', { returnStage: 'build' });

  it('is refused to a stage a fast job never visits, naming cancel and ticket reopen', () => {
    for (const to of ['spec', 'simplify', 'review', 'approve'] as const) {
      expect(() => run(blocked, 'resume', ctx([], { to }))).toThrow(
        /cancel the job and `orch ticket reopen` it to run the full workflow/,
      );
    }
  });

  it('is allowed to build, pr, and ci', () => {
    for (const to of ['build', 'pr', 'ci'] as const) {
      expect(run(blocked, 'resume', ctx([], { to })).patch.stage).toBe(to);
    }
  });

  it('a full job still resumes to review', () => {
    const full = job('needs-human', 'blocked', { returnStage: 'build', mode: 'full' });
    expect(run(full, 'resume', ctx([], { to: 'review' })).patch.stage).toBe('review');
  });
});
