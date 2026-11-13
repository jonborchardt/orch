import { describe, expect, it } from 'vitest';

import { WorkflowError } from '../src/core/errors.ts';
import {
  type Action,
  describeNext,
  requiredArtifact,
  type Stage,
  type Status,
  transition,
  type TransitionContext,
} from '../src/core/workflow.ts';
import type { Artifact, Review } from '../src/storage/schema.ts';

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
    ...extra,
  };
}

function art(path: string, marker: string | null = null): Artifact {
  if (path === 'decision.md' && marker === null) marker = 'approve';
  return {
    id: 1,
    jobId: 'j',
    stage: 'spec',
    round: null,
    path,
    bytes: 1,
    sha256: null,
    marker,
    head: null,
    createdAt: '',
  };
}

function review(round: number, reviewer: string, verdict: Review['verdict']): Review {
  return {
    id: 1,
    jobId: 'j',
    round,
    reviewer,
    verdict,
    artifactId: null,
    head: null,
    summary: null,
    createdAt: '',
    completedAt: null,
  };
}

const none: TransitionContext = { artifacts: [], reviews: [] };
const run = (j: JobState, action: Action, ctx = none) => transition(j, action, ctx);
const step = (j: JobState, action: Action, ctx = none): JobState => ({
  ...j,
  ...run(j, action, ctx).patch,
});

describe('transition: happy path', () => {
  it('walks spec -> build -> review -> approve -> pr -> completed', () => {
    let j = job('spec', 'pending');
    j = step(j, 'start');
    expect(j.status).toBe('running');
    j = step(j, 'complete', { artifacts: [art('spec.md')], reviews: [] });
    expect([j.stage, j.status]).toEqual(['build', 'pending']);
    j = step(j, 'start');
    j = step(j, 'complete', { artifacts: [art('build.md')], reviews: [] });
    expect([j.stage, j.status, j.round]).toEqual(['review', 'pending', 1]);
    j = step(j, 'start');
    const r = run(j, 'complete', {
      artifacts: [art('round-1/consolidated.md')],
      reviews: [review(1, 'code', 'pass'), review(1, 'security', 'pass')],
    });
    expect(r.events[0]?.payload['changesRequestedBy']).toEqual([]);
    j = { ...j, ...r.patch };
    expect([j.stage, j.status]).toEqual(['approve', 'pending']);
    j = step(j, 'start');
    j = step(j, 'complete', { artifacts: [art('decision.md')], reviews: [] });
    expect(j.stage).toBe('pr');
    j = step(j, 'start');
    const delivered = [art('pr.md'), art('decision.md')];
    expect(() => run(j, 'complete', { artifacts: delivered, reviews: [] })).toThrow(
      /record the PR/,
    );
    j = { ...j, prUrl: 'https://x/pr/1', prState: 'draft' };
    // A PR alone is not completion: the approval must be on record too.
    expect(() => run(j, 'complete', { artifacts: [art('pr.md')], reviews: [] })).toThrow(
      /no DECISION: APPROVE/,
    );
    const done = run(j, 'complete', { artifacts: delivered, reviews: [] });
    expect(done.patch.stage).toBe('completed');
    expect(done.patch.status).toBe('completed');
    expect(done.patch.completedAt).toBeTruthy();
    expect(done.events.map((e) => e.type)).toEqual(['stage.completed', 'job.completed']);
  });
});

describe('transition: illegal moves', () => {
  it('rejects completing a stage that is not running', () => {
    expect(() => run(job('spec', 'pending'), 'complete')).toThrow(WorkflowError);
  });

  it('rejects duplicate start (already running)', () => {
    expect(() => run(job('build', 'running'), 'start')).toThrow(/not startable/);
  });

  it('rejects completing without the required artifact', () => {
    expect(() => run(job('spec', 'running'), 'complete')).toThrow(
      /missing required artifact spec.md/,
    );
    expect(() =>
      run(job('review', 'running', { round: 2 }), 'complete', {
        artifacts: [art('round-1/consolidated.md')],
        reviews: [review(2, 'code', 'pass')],
      }),
    ).toThrow(/round-2\/consolidated.md/);
  });

  it('rejects everything on a finished job', () => {
    for (const a of ['start', 'complete', 'fail', 'escalate', 'resume'] as const) {
      expect(() => run(job('completed', 'completed'), a)).toThrow(/finished/);
    }
    expect(() => run(job('completed', 'completed'), 'cancel')).toThrow(/finished/);
    expect(() => run(job('build', 'cancelled'), 'cancel')).toThrow(/already cancelled/);
  });

  it('approve completes only on DECISION: APPROVE', () => {
    expect(() =>
      run(job('approve', 'running'), 'complete', {
        artifacts: [art('decision.md', 'escalate')],
        reviews: [],
      }),
    ).toThrow(/says ESCALATE; use escalate/);
    expect(() =>
      run(job('approve', 'running'), 'complete', { artifacts: [art('decision.md')], reviews: [] }),
    ).not.toThrow();
  });

  it('cannot start needs-human directly', () => {
    expect(() => run(job('needs-human', 'pending'), 'start')).toThrow(/--to/);
  });

  it('fail only applies to a running stage', () => {
    expect(() => run(job('build', 'pending'), 'fail')).toThrow(WorkflowError);
    const r = run(job('build', 'running'), 'fail', { ...none, reason: 'tests red' });
    expect(r.patch.status).toBe('failed');
    expect(r.events[0]?.payload['reason']).toBe('tests red');
  });
});

describe('transition: review loop', () => {
  const inReview = (round: number, maxRounds = 3) => job('review', 'running', { round, maxRounds });
  const consolidated = (round: number) => art(`round-${String(round)}/consolidated.md`);

  it('requires at least one reviewer and no pending verdicts', () => {
    expect(() =>
      run(inReview(1), 'complete', { artifacts: [consolidated(1)], reviews: [] }),
    ).toThrow(/No reviewers/);
    expect(() =>
      run(inReview(1), 'complete', {
        artifacts: [consolidated(1)],
        reviews: [review(1, 'code', 'pass'), review(1, 'security', null)],
      }),
    ).toThrow(/pending: security/);
  });

  it('ignores reviews from earlier rounds', () => {
    expect(() =>
      run(inReview(2), 'complete', {
        artifacts: [consolidated(2)],
        reviews: [review(1, 'code', 'pass')],
      }),
    ).toThrow(/No reviewers/);
  });

  it('sends the job back to build on CHANGES; the next build bumps the round', () => {
    const r = run(inReview(1), 'complete', {
      artifacts: [consolidated(1)],
      reviews: [review(1, 'code', 'changes'), review(1, 'security', 'pass')],
    });
    expect(r.patch).toEqual({ stage: 'build', status: 'pending' });
    expect(r.events[0]?.payload['changesRequestedBy']).toEqual(['code']);
    const next = run(job('build', 'running', { round: 1 }), 'complete', {
      artifacts: [art('build.md')],
      reviews: [],
    });
    expect(next.patch.round).toBe(2);
  });

  it('escalates to needs-human when the last allowed round still requests changes', () => {
    const r = run(inReview(3), 'complete', {
      artifacts: [consolidated(3)],
      reviews: [review(3, 'code', 'changes')],
    });
    expect(r.patch).toEqual({ stage: 'needs-human', status: 'blocked', returnStage: 'build' });
    expect(r.events.map((e) => e.type)).toEqual(['stage.completed', 'job.blocked']);
  });
});

describe('transition: escalation, resume, cancel', () => {
  it('escalate records the return stage; resume goes back there by default', () => {
    const e = run(job('build', 'running'), 'escalate', { ...none, reason: 'unclear spec' });
    expect(e.patch).toEqual({ stage: 'needs-human', status: 'blocked', returnStage: 'build' });
    const blocked = job('needs-human', 'blocked', { returnStage: 'build' });
    expect(run(blocked, 'resume').patch).toEqual({
      stage: 'build',
      status: 'pending',
      returnStage: null,
    });
    expect(run(blocked, 'resume', { ...none, to: 'spec' }).patch.stage).toBe('spec');
    expect(() => run(blocked, 'resume', { ...none, to: 'completed' })).toThrow(/--to/);
    expect(() => run(job('needs-human', 'blocked'), 'escalate')).toThrow(/already escalated/);
  });

  it('resume on an interrupted or failed stage returns it to pending', () => {
    expect(run(job('build', 'interrupted'), 'resume').patch).toEqual({ status: 'pending' });
    expect(run(job('build', 'failed'), 'resume').patch).toEqual({ status: 'pending' });
    expect(() => run(job('build', 'running'), 'resume')).toThrow(/nothing to resume/);
    expect(() => run(job('build', 'pending'), 'resume')).toThrow(/nothing to resume/);
  });

  it('cancel works from any live state and stamps completedAt', () => {
    for (const s of ['pending', 'running', 'blocked', 'interrupted', 'failed'] as const) {
      const r = run(job('review', s), 'cancel');
      expect(r.patch.status).toBe('cancelled');
      expect(r.patch.completedAt).toBeTruthy();
    }
  });
});

describe('describeNext / requiredArtifact', () => {
  it('names the artifact the current stage needs', () => {
    expect(requiredArtifact('review', 2)).toBe('round-2/consolidated.md');
    expect(requiredArtifact('needs-human', 0)).toBeUndefined();
    expect(describeNext({ stage: 'review', status: 'pending', round: 2 })).toEqual({
      stage: 'review',
      status: 'pending',
      requiredArtifacts: ['round-2/consolidated.md'],
      round: 2,
    });
    const done = describeNext({ stage: 'completed', status: 'completed', round: 1 });
    expect(done.requiredArtifacts).toEqual([]);
  });
});
