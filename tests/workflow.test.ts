import { describe, expect, it } from 'vitest';

import { WorkflowError } from '../src/core/errors.ts';
import {
  type Action,
  cannotAcceptDelivery,
  challengeSlot,
  challengeSpecHash,
  completionOf,
  describeNext,
  latestChallenge,
  MAX_ROUNDS_REASON,
  requiredArtifact,
  SCOPE_GAP_REASON,
  type Stage,
  STAGES,
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
    ciStatus: null,
    ciHead: null,
    ciRepairs: 0,
    maxCiRepairs: 2,
    scopeReworks: 0,
    startedAt: null,
    ...extra,
  };
}

function art(path: string, marker: string | null = null, extra: Partial<Artifact> = {}): Artifact {
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
    specSha256: null,
    createdAt: '',
    ...extra,
  };
}

/** spec.md registered with hash `s1`, challenged by `spec-review-1.md` saying PASS. */
const passedSpec = (): Artifact[] => [
  art('spec.md', null, { sha256: 's1' }),
  art('spec-review-1.md', 'pass', { specSha256: 's1' }),
];

function simplified(round: number): Artifact[] {
  return [
    art(`round-${String(round)}/simplify-review.md`),
    art(`round-${String(round)}/simplify.md`),
  ];
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

/** The three always-on reviewers for `round`; the names in `changes` request changes. */
function trio(round: number, ...changes: string[]): Review[] {
  return ['security', 'correctness', 'code-quality'].map((r) =>
    review(round, r, changes.includes(r) ? 'changes' : 'pass'),
  );
}

const none: TransitionContext = { artifacts: [], reviews: [] };
const run = (j: JobState, action: Action, ctx = none) => transition(j, action, ctx);
const step = (j: JobState, action: Action, ctx = none): JobState => ({
  ...j,
  ...run(j, action, ctx).patch,
});

describe('transition: startedAt', () => {
  it('stamps the first start once; a restart or the next stage keeps it', () => {
    let j = step(job('spec', 'pending'), 'start');
    const first = j.startedAt;
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    j = step(j, 'fail');
    expect(run(j, 'start').patch).not.toHaveProperty('startedAt');
    j = step(step(j, 'start'), 'complete', { artifacts: passedSpec(), reviews: [] });
    expect(run(j, 'start').patch).not.toHaveProperty('startedAt');
    expect(step(j, 'start').startedAt).toBe(first);
  });
});

describe('transition: happy path', () => {
  it('walks spec -> build -> simplify -> review -> approve -> pr -> ci -> completed', () => {
    let j = job('spec', 'pending');
    j = step(j, 'start');
    expect(j.status).toBe('running');
    j = step(j, 'complete', { artifacts: passedSpec(), reviews: [] });
    expect([j.stage, j.status]).toEqual(['build', 'pending']);
    j = step(j, 'start');
    j = step(j, 'complete', { artifacts: [art('build.md')], reviews: [] });
    expect([j.stage, j.status, j.round]).toEqual(['simplify', 'pending', 1]);
    j = step(j, 'start');
    j = step(j, 'complete', { artifacts: simplified(1), reviews: [] });
    expect([j.stage, j.status, j.round]).toEqual(['review', 'pending', 1]);
    j = step(j, 'start');
    const r = run(j, 'complete', {
      artifacts: [art('round-1/consolidated.md')],
      reviews: trio(1),
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
    j = step(j, 'complete', { artifacts: delivered, reviews: [] });
    expect([j.stage, j.status]).toEqual(['ci', 'pending']);
    j = step(j, 'start');
    // A recorded PR is not a delivery: GitHub's verdict for the PR head is.
    expect(() => run(j, 'complete')).toThrow(/no CI verdict has been read/);
    j = { ...j, ciStatus: 'pending', ciHead: 'abc' };
    expect(() => run(j, 'complete')).toThrow(/required checks are pending/);
    j = { ...j, ciStatus: 'failing' };
    expect(() => run(j, 'complete')).toThrow(/required checks are failing/);
    j = { ...j, ciStatus: 'none' };
    expect(() => run(j, 'complete')).toThrow(/required checks are none/);
    j = { ...j, ciStatus: 'passing', ciHead: null };
    expect(() => run(j, 'complete')).toThrow(/run orch gh ci/);
    // A PR closed without merging cannot be completed, even with a passing head recorded.
    expect(() => run({ ...j, ciHead: 'abc', prState: 'closed' }, 'complete')).toThrow(
      /closed without merging/,
    );
    j = { ...j, ciHead: 'abc' };
    const done = run(j, 'complete');
    expect(done.patch.stage).toBe('completed');
    expect(done.patch.status).toBe('completed');
    expect(done.patch.completedAt).toBeTruthy();
    expect(done.events.map((e) => e.type)).toEqual(['stage.completed', 'job.completed']);
    expect(done.events[1]?.payload).toEqual({ prUrl: 'https://x/pr/1', head: 'abc' });
  });
});

describe('transition: a PR merged by a human completes ci', () => {
  const ci = (extra: Partial<JobState>) =>
    job('ci', 'running', { prUrl: 'https://x/pr/1', ciHead: 'abc', ...extra });
  const merged: TransitionContext = { ...none, mergedByHuman: true };

  it('completes with the flag on a merged PR whatever the checks say', () => {
    for (const ciStatus of ['pending', 'failing', 'none', 'passing'] as const) {
      const r = run(ci({ prState: 'merged', ciStatus }), 'complete', merged);
      expect(r.patch).toMatchObject({ stage: 'completed', status: 'completed' });
      expect(r.events[1]?.payload).toEqual({
        prUrl: 'https://x/pr/1',
        head: 'abc',
        ciStatus,
        mergedByHuman: true,
        reason: 'merged by a human before CI finished',
      });
      expect(completionOf('completed', r.events[1]?.payload)).toBe('merged');
    }
  });

  it('never completes on a stored merge alone, nor with the flag on an unmerged PR or no head', () => {
    for (const ciStatus of ['pending', 'failing'] as const) {
      expect(() => run(ci({ prState: 'merged', ciStatus }), 'complete')).toThrow(
        new RegExp(`required checks are ${ciStatus}`),
      );
    }
    expect(() => run(ci({ prState: 'ready', ciStatus: 'pending' }), 'complete', merged)).toThrow(
      /not recorded as merged/,
    );
    expect(() =>
      run(ci({ prState: 'merged', ciStatus: 'pending', ciHead: null }), 'complete', merged),
    ).toThrow(/no CI verdict has been read/);
    // A passing completion without the flag keeps its plain payload and completion.
    const plain = run(ci({ prState: 'merged', ciStatus: 'passing' }), 'complete');
    expect(completionOf('completed', plain.events[1]?.payload)).toBe('ci');
  });
});

describe('transition: CI repair cycle', () => {
  const ci = (extra: Partial<JobState> = {}) =>
    job('ci', 'running', {
      prUrl: 'https://x/pr/1',
      prState: 'draft',
      ciStatus: 'failing',
      ciHead: 'abc',
      ...extra,
    });

  it('rework from ci counts a repair and returns to build; pr rework does not count', () => {
    // Neither is review-driven: both raise maxRounds for the round they open.
    const r = run(ci(), 'rework', { ...none, reason: 'CI failed: test' });
    expect(r.patch).toEqual({ stage: 'build', status: 'pending', ciRepairs: 1, maxRounds: 4 });
    expect(r.events).toEqual([
      {
        type: 'job.reworked',
        payload: { from: 'ci', reason: 'CI failed: test', ciRepairs: 1, maxRounds: 4 },
      },
    ]);
    const pr = run(job('pr', 'running', { ciRepairs: 1 }), 'rework');
    expect(pr.patch).toEqual({ stage: 'build', status: 'pending', maxRounds: 4 });
    expect(pr.events[0]?.payload).toMatchObject({ from: 'pr', maxRounds: 4 });
    expect(() => run(job('build', 'running'), 'rework')).toThrow(/approve, pr and ci stages/);
    expect(() => run(job('review', 'running'), 'rework')).toThrow(/approve, pr and ci stages/);
  });

  it('base-integration rework from approve returns to build without counting a repair, from any status', () => {
    for (const status of ['running', 'pending', 'failed'] as const) {
      const r = run(job('approve', status, { ciRepairs: 1, scopeReworks: 1 }), 'rework', {
        ...none,
        reason: 'base conflicts',
        integration: true,
      });
      expect(r.patch).toEqual({ stage: 'build', status: 'pending', maxRounds: 4 });
      expect(r.events).toEqual([
        {
          type: 'job.reworked',
          payload: {
            from: 'approve',
            reason: 'base conflicts',
            ciRepairs: 1,
            maxRounds: 4,
            integration: true,
          },
        },
      ]);
    }
  });

  it('escalates instead of a third repair when the budget is spent; the reason is recorded', () => {
    const r = run(ci({ ciRepairs: 2, maxCiRepairs: 2 }), 'rework', { ...none, reason: 'again' });
    expect(r.patch).toEqual({ stage: 'needs-human', status: 'blocked', returnStage: 'build' });
    expect(r.events).toEqual([
      {
        type: 'job.blocked',
        payload: { from: 'ci', reason: 'max CI repair cycles reached', detail: 'again' },
      },
    ]);
    // maxCiRepairs 0 means the first failure already needs a human.
    expect(run(ci({ maxCiRepairs: 0 }), 'rework').patch.stage).toBe('needs-human');
  });

  it('base-integration rework from ci spends no repair and never escalates for the budget', () => {
    for (const extra of [{}, { ciRepairs: 2, maxCiRepairs: 2 }, { maxCiRepairs: 0 }]) {
      const before = ci(extra);
      const r = run(before, 'rework', { ...none, reason: 'base conflicts', integration: true });
      expect(r.patch).toEqual({ stage: 'build', status: 'pending', maxRounds: 4 });
      expect(r.events).toEqual([
        {
          type: 'job.reworked',
          payload: {
            from: 'ci',
            reason: 'base conflicts',
            ciRepairs: before.ciRepairs,
            maxRounds: 4,
            integration: true,
          },
        },
      ]);
    }
  });

  it('a human may close out only a no-checks or merged delivery escalated from ci', () => {
    const blocked = (extra: Partial<JobState>) =>
      job('needs-human', 'blocked', {
        returnStage: 'ci',
        prUrl: 'https://x/pr/1',
        prState: 'draft',
        ciHead: 'abc',
        ...extra,
      });
    const to = (j: JobState) =>
      run(j, 'resume', { ...none, to: 'completed', reason: 'no CI here' });
    expect(() => to(blocked({ ciStatus: 'failing' }))).toThrow(/required checks are failing/);
    expect(() => to(blocked({ ciStatus: 'pending' }))).toThrow(/required checks are pending/);
    expect(() => to(blocked({ ciStatus: 'none', ciHead: null }))).toThrow(/no PR head/);
    expect(() => to(blocked({ ciStatus: 'none', returnStage: 'build' }))).toThrow(
      /escalated from the ci stage/,
    );
    expect(() =>
      run(blocked({ ciStatus: 'none', returnStage: 'pr' }), 'resume', none),
    ).not.toThrow();
    const ok = to(blocked({ ciStatus: 'none' }));
    expect([ok.patch.stage, ok.patch.status, ok.patch.returnStage]).toEqual([
      'completed',
      'completed',
      null,
    ]);
    expect(ok.events.map((e) => e.type)).toEqual(['job.resumed', 'job.completed']);
    expect(ok.events[1]?.payload).toMatchObject({ acceptedByHuman: true, reason: 'no CI here' });
    expect(to(blocked({ ciStatus: 'failing', prState: 'merged' })).patch.stage).toBe('completed');
    // The ordinary resume keeps working and never completes anything.
    expect(run(blocked({ ciStatus: 'none' }), 'resume', none).patch.stage).toBe('ci');
  });
});

describe('transition: simplify', () => {
  it('lists simplify between build and review and requires its round-N record', () => {
    expect(STAGES.slice(1, 4)).toEqual(['build', 'simplify', 'review']);
    expect(requiredArtifact('simplify', 2)).toBe('round-2/simplify.md');
    expect(describeNext(job('simplify', 'pending', { round: 2 })).requiredArtifacts).toEqual([
      'round-2/simplify-review.md',
      'round-2/simplify.md',
    ]);
  });

  it('build completes to simplify with the next round; simplify keeps it and enters review', () => {
    const built = run(job('build', 'running', { round: 1 }), 'complete', {
      artifacts: [art('build.md')],
      reviews: [],
    });
    expect(built.patch).toEqual({ stage: 'simplify', status: 'pending', round: 2 });
    const done = run(job('simplify', 'running', { round: 2 }), 'complete', {
      artifacts: simplified(2),
      reviews: [],
    });
    expect(done.patch).toEqual({ stage: 'review', status: 'pending' });
  });

  it('refuses completion without the findings or without the record of this round', () => {
    const j = job('simplify', 'running', { round: 2 });
    const findings = simplified(2).slice(0, 1);
    const record = simplified(2).slice(1);
    expect(() => run(j, 'complete', { artifacts: record, reviews: [] })).toThrow(
      /missing required artifact round-2\/simplify-review.md/,
    );
    expect(() => run(j, 'complete', { artifacts: findings, reviews: [] })).toThrow(
      /missing required artifact round-2\/simplify.md/,
    );
    expect(() => run(j, 'complete', { artifacts: simplified(1), reviews: [] })).toThrow(
      WorkflowError,
    );
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
        reviews: trio(2),
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
        reviews: [review(1, 'code-quality', 'pass'), review(1, 'security', null)],
      }),
    ).toThrow(/pending: security/);
  });

  it('ignores reviews from earlier rounds', () => {
    expect(() =>
      run(inReview(2), 'complete', {
        artifacts: [consolidated(2)],
        reviews: trio(1),
      }),
    ).toThrow(/No reviewers/);
  });

  it('requires every always-on reviewer: one PASS is not a review', () => {
    expect(() =>
      run(inReview(1), 'complete', {
        artifacts: [consolidated(1)],
        reviews: [review(1, 'code-quality', 'pass')],
      }),
    ).toThrow(/Required reviewers not recorded this round: security, correctness/);
    // UI reviewers are extra, never a substitute.
    expect(() =>
      run(inReview(1), 'complete', {
        artifacts: [consolidated(1)],
        reviews: [review(1, 'ux', 'pass'), review(1, 'security', 'pass')],
      }),
    ).toThrow(/correctness, code-quality/);
    const all = run(inReview(1), 'complete', {
      artifacts: [consolidated(1)],
      reviews: [...trio(1), review(1, 'ux', 'pass')],
    });
    expect(all.patch.stage).toBe('approve');
  });

  it('sends the job back to build on CHANGES; the next build bumps the round', () => {
    const r = run(inReview(1), 'complete', {
      artifacts: [consolidated(1)],
      reviews: trio(1, 'correctness'),
    });
    expect(r.patch).toEqual({ stage: 'build', status: 'pending' });
    expect(r.events[0]?.payload['changesRequestedBy']).toEqual(['correctness']);
    const next = run(job('build', 'running', { round: 1 }), 'complete', {
      artifacts: [art('build.md')],
      reviews: [],
    });
    expect(next.patch.round).toBe(2);
  });

  it('escalates to needs-human when the maxRounds-th review rejects', () => {
    const r = run(inReview(3), 'complete', {
      artifacts: [consolidated(1), consolidated(2), consolidated(3)],
      reviews: [...trio(1, 'security'), ...trio(2, 'correctness'), ...trio(3, 'code-quality')],
    });
    expect(r.patch).toEqual({ stage: 'needs-human', status: 'blocked', returnStage: 'build' });
    expect(r.events.map((e) => e.type)).toEqual(['stage.completed', 'job.blocked']);
    // A consolidation counting blocking findings is a rejection too, even when every verdict passed.
    const blocked = run(inReview(3), 'complete', {
      artifacts: [art('round-1/consolidated.md', '2'), consolidated(2), consolidated(3)],
      reviews: [...trio(1), ...trio(2, 'security'), ...trio(3, 'security')],
    });
    expect(blocked.patch.stage).toBe('needs-human');
  });

  it('a rejection escalates exactly when round >= maxRounds, whatever earlier rounds said', () => {
    const reject = (round: number, maxRounds: number) =>
      run(inReview(round, maxRounds), 'complete', {
        artifacts: [consolidated(round)],
        reviews: trio(round, 'security'),
      });
    // A CI repair or base rework raised maxRounds to 4: round 3 still goes back to build.
    expect(reject(3, 4).patch).toEqual({ stage: 'build', status: 'pending' });
    expect(reject(2, 3).patch.stage).toBe('build');
    const last = reject(4, 4);
    expect(last.patch.stage).toBe('needs-human');
    expect(last.events[1]?.payload['reason']).toBe(MAX_ROUNDS_REASON);
    // Rounds already past the maximum (jobs from before raises were recorded) escalate too.
    expect(reject(5, 3).patch.stage).toBe('needs-human');
    // A passing review never escalates, even past the maximum.
    const passed = run(inReview(5, 3), 'complete', {
      artifacts: [consolidated(5)],
      reviews: trio(5),
    });
    expect(passed.patch.stage).toBe('approve');
  });

  it('maxRounds 1 escalates on the first rejection', () => {
    const r = run(inReview(1, 1), 'complete', {
      artifacts: [consolidated(1)],
      reviews: trio(1, 'security'),
    });
    expect(r.patch.stage).toBe('needs-human');
  });
});

describe('transition: the spec challenge gate', () => {
  const spec = (sha = 's1') => art('spec.md', null, { sha256: sha });
  const challenge = (n: number, marker: string, specSha256 = 's1') =>
    art(`spec-review-${String(n)}.md`, marker, { specSha256 });
  const complete = (artifacts: Artifact[]) =>
    run(job('spec', 'running'), 'complete', { artifacts, reviews: [] });

  it('refuses spec completion without a PASS bound to the current spec.md', () => {
    expect(() => complete([spec()])).toThrow(/no spec challenge.*factory-spec-challenger/);
    expect(() => complete([spec(), challenge(1, 'changes')])).toThrow(
      /spec-review-1.md from factory-spec-challenger says CHANGES/,
    );
    // The latest challenge decides: a PASS in review-1 does not outlive a CHANGES in review-2.
    expect(() => complete([spec(), challenge(1, 'pass'), challenge(2, 'changes')])).toThrow(
      /spec-review-2.md .* says CHANGES/,
    );
    // spec.md replaced (--replace) after the PASS: the PASS reviewed an earlier spec.
    expect(() => complete([spec('s2'), challenge(1, 'pass')])).toThrow(
      /factory-spec-challenger passed an earlier spec.md/,
    );
    expect(complete([spec(), challenge(1, 'pass')]).patch.stage).toBe('build');
    expect(
      complete([spec('s2'), challenge(1, 'changes'), challenge(2, 'pass', 's2')]).patch,
    ).toEqual({ stage: 'build', status: 'pending' });
  });

  it('applies to leaving a spec escalation for a later stage, and only to that', () => {
    const blocked = job('needs-human', 'blocked', { returnStage: 'spec' });
    const failing = { ...none, artifacts: [spec(), challenge(2, 'changes')] };
    for (const to of ['build', 'review', 'approve', 'pr'] as const) {
      expect(() => run(blocked, 'resume', { ...failing, to })).toThrow(/says CHANGES/);
      // The job is already escalated: the advice is to re-challenge and resume, not escalate.
      expect(() => run(blocked, 'resume', { ...failing, to })).toThrow(
        /revise spec.md and re-challenge it, then resume/,
      );
    }
    expect(run(blocked, 'resume', failing).patch.stage).toBe('spec');
    expect(run(blocked, 'resume', { ...failing, to: 'spec' }).patch.stage).toBe('spec');
    const passing = { ...none, artifacts: [spec(), challenge(1, 'pass')], to: 'build' as const };
    expect(run(blocked, 'resume', passing).patch.stage).toBe('build');
    // Escalations from later stages never look at the challenge.
    const fromBuild = job('needs-human', 'blocked', { returnStage: 'build' });
    expect(run(fromBuild, 'resume', { ...none, to: 'review' }).patch.stage).toBe('review');
  });

  it('counts only spec-review-1.md and spec-review-2.md as challenges', () => {
    // A stray spec-review-3.md row can neither satisfy nor wedge the gate.
    expect(() => complete([spec(), challenge(3, 'pass')])).toThrow(/no spec challenge/);
    expect(complete([spec(), challenge(1, 'pass'), challenge(3, 'changes')]).patch.stage).toBe(
      'build',
    );
    expect(latestChallenge([challenge(1, 'pass'), challenge(3, 'changes')])?.path).toBe(
      'spec-review-1.md',
    );
    expect([1, 2, 3, 10].map((n) => challengeSlot(`spec-review-${String(n)}.md`))).toEqual([
      1, 2, 0, 0,
    ]);
    expect(() => challengeSpecHash('spec-review-3.md', [spec()])).toThrow(
      /not a spec challenge slot/,
    );
    expect(() => challengeSpecHash('spec-review-2.md', [spec(), challenge(1, 'pass')])).toThrow(
      /register spec-review-1.md instead/,
    );
  });
});

describe('transition: escalation, resume, cancel', () => {
  it('escalate records the return stage; resume goes back there by default', () => {
    const e = run(job('build', 'running'), 'escalate', { ...none, reason: 'unclear spec' });
    expect(e.patch).toEqual({ stage: 'needs-human', status: 'blocked', returnStage: 'build' });
    const blocked = job('needs-human', 'blocked', { returnStage: 'build' });
    // The human's resume to build grants the round it leads to.
    expect(run(blocked, 'resume').patch).toEqual({
      stage: 'build',
      status: 'pending',
      returnStage: null,
      maxRounds: 4,
    });
    expect(run(blocked, 'resume', { ...none, to: 'spec' }).patch).toEqual({
      stage: 'spec',
      status: 'pending',
      returnStage: null,
    });
    // Closing out is reserved for CI escalations with nothing to verify (see the CI tests).
    expect(() => run(blocked, 'resume', { ...none, to: 'completed' })).toThrow(
      /escalated from the ci stage/,
    );
    expect(() => run(job('needs-human', 'blocked'), 'escalate')).toThrow(/already escalated/);
  });

  it('resume on an interrupted or failed stage returns it to pending', () => {
    expect(run(job('build', 'interrupted'), 'resume').patch).toEqual({ status: 'pending' });
    expect(run(job('build', 'failed'), 'resume').patch).toEqual({ status: 'pending' });
    expect(() => run(job('build', 'running'), 'resume')).toThrow(/nothing to resume/);
    expect(() => run(job('build', 'pending'), 'resume')).toThrow(/nothing to resume/);
  });

  it('resume from needs-human into review opens a new round; resuming a review stage keeps it', () => {
    const blocked = job('needs-human', 'blocked', { round: 2, returnStage: 'approve' });
    const toReview = run(blocked, 'resume', { ...none, to: 'review' });
    expect(toReview.patch).toEqual({
      stage: 'review',
      status: 'pending',
      returnStage: null,
      round: 3,
      maxRounds: 4,
    });
    expect(toReview.events).toEqual([
      { type: 'job.resumed', payload: { to: 'review', maxRounds: 4 } },
    ]);
    // Escalated mid-review: the default return to review is a fresh round too.
    const midReview = job('needs-human', 'blocked', { round: 2, returnStage: 'review' });
    expect(run(midReview, 'resume').patch.round).toBe(3);
    // A simplify requested from needs-human opens a new round too: its files belong to that round.
    expect(run(blocked, 'resume', { ...none, to: 'simplify' }).patch).toEqual({
      stage: 'simplify',
      status: 'pending',
      returnStage: null,
      round: 3,
      maxRounds: 4,
    });
    // Any other target keeps the round.
    expect(run(blocked, 'resume', { ...none, to: 'build' }).patch.round).toBeUndefined();
    // An interrupted or failed review resumes in its own round.
    for (const s of ['interrupted', 'failed'] as const) {
      expect(run(job('review', s, { round: 2 }), 'resume').patch).toEqual({ status: 'pending' });
    }
  });

  it('only a resume to build, simplify, or review raises maxRounds', () => {
    const blocked = job('needs-human', 'blocked', { round: 2, returnStage: 'build' });
    for (const to of ['build', 'simplify', 'review'] as const) {
      expect(run(blocked, 'resume', { ...none, to }).patch.maxRounds).toBe(4);
    }
    for (const to of ['spec', 'approve', 'pr', 'ci'] as const) {
      const r = run(blocked, 'resume', { ...none, to });
      expect(r.patch.maxRounds).toBeUndefined();
      expect(r.events[0]?.payload).toEqual({ to });
    }
    const closeOut = job('needs-human', 'blocked', {
      returnStage: 'ci',
      prUrl: 'https://x/pr/1',
      ciHead: 'abc',
      ciStatus: 'none',
    });
    expect(run(closeOut, 'resume', { ...none, to: 'completed' }).patch.maxRounds).toBeUndefined();
    for (const s of ['interrupted', 'failed'] as const) {
      expect(run(job('build', s), 'resume').patch.maxRounds).toBeUndefined();
    }
    // An exhausted CI repair escalates and raises nothing.
    const spent = job('ci', 'running', { prUrl: 'https://x/pr/1', ciRepairs: 2 });
    expect(run(spent, 'rework').patch.maxRounds).toBeUndefined();
  });

  it('cancel works from any live state and stamps completedAt', () => {
    for (const s of ['pending', 'running', 'blocked', 'interrupted', 'failed'] as const) {
      const r = run(job('review', s), 'cancel');
      expect(r.patch.status).toBe('cancelled');
      expect(r.patch.completedAt).toBeTruthy();
    }
  });
});

describe('cannotAcceptDelivery', () => {
  const base = {
    stage: 'needs-human' as const,
    returnStage: 'ci' as const,
    prUrl: 'https://github.com/o/r/pull/1',
    ciHead: 'abc',
    ciStatus: 'none' as const,
    prState: 'draft' as const,
  };
  it('allows a ci escalation with no checks, or a PR merged by hand; refuses everything else', () => {
    expect(cannotAcceptDelivery(base)).toBeNull();
    expect(cannotAcceptDelivery({ ...base, ciStatus: 'failing', prState: 'merged' })).toBeNull();
    expect(cannotAcceptDelivery({ ...base, ciStatus: 'pending' })).toMatch(/pending/);
    expect(cannotAcceptDelivery({ ...base, ciStatus: 'failing' })).toMatch(/failing/);
    expect(cannotAcceptDelivery({ ...base, ciStatus: null })).toMatch(/not observed/);
    expect(cannotAcceptDelivery({ ...base, ciHead: null })).toMatch(/no PR head/);
    expect(cannotAcceptDelivery({ ...base, prUrl: null })).toMatch(/no PR head/);
    expect(cannotAcceptDelivery({ ...base, returnStage: 'approve' })).toMatch(
      /escalated from the ci/,
    );
    expect(cannotAcceptDelivery({ ...base, stage: 'ci' })).toMatch(/escalated from the ci/);
  });
});

describe('transition: scope-gap rework from approve', () => {
  const decided = (marker: string, extra: Partial<Artifact> = {}): TransitionContext => ({
    ...none,
    artifacts: [art('decision.md', marker, extra)],
    reason: 'two requested cases missing',
  });

  it('REWORK-BUILD goes back to build and REWORK-SPEC to spec, counting one scope rework', () => {
    for (const [marker, to] of [
      ['rework-build', 'build'],
      ['rework-spec', 'spec'],
    ] as const) {
      const r = run(job('approve', 'running', { round: 2 }), 'rework', decided(marker));
      expect(r.patch).toEqual({ stage: to, status: 'pending', scopeReworks: 1, maxRounds: 4 });
      expect(r.events).toEqual([
        {
          type: 'job.reworked',
          payload: {
            from: 'approve',
            reason: 'two requested cases missing',
            ciRepairs: 0,
            maxRounds: 4,
            scopeGap: to,
          },
        },
      ]);
    }
  });

  it('is refused without a REWORK decision; integration rework ignores the decision', () => {
    const j = job('approve', 'running');
    expect(() => run(j, 'rework')).toThrow(/says NOTHING; rework from approve needs DECISION/);
    for (const marker of ['approve', 'escalate']) {
      expect(() => run(j, 'rework', decided(marker))).toThrow(
        new RegExp(`says ${marker.toUpperCase()}; rework from approve needs`),
      );
    }
    const base = run(j, 'rework', { ...decided('approve'), integration: true });
    expect(base.patch).toEqual({ stage: 'build', status: 'pending', maxRounds: 4 });
  });

  it('a second scope gap escalates to a human, returning to the requested stage', () => {
    for (const [marker, to] of [
      ['rework-build', 'build'],
      ['rework-spec', 'spec'],
    ] as const) {
      const r = run(job('approve', 'running', { scopeReworks: 1 }), 'rework', decided(marker));
      expect(r.patch).toEqual({ stage: 'needs-human', status: 'blocked', returnStage: to });
      expect(r.events).toEqual([
        {
          type: 'job.blocked',
          payload: {
            from: 'approve',
            reason: SCOPE_GAP_REASON,
            detail: 'two requested cases missing',
          },
        },
      ]);
    }
  });

  it('complete from approve on a REWORK decision names rework; APPROVE and ESCALATE unchanged', () => {
    const j = job('approve', 'running');
    for (const marker of ['rework-build', 'rework-spec']) {
      expect(() => run(j, 'complete', decided(marker))).toThrow(
        new RegExp(`${marker.toUpperCase()}; use rework`),
      );
    }
    expect(() => run(j, 'complete', decided('escalate'))).toThrow(/ESCALATE; use escalate/);
    expect(run(j, 'complete', decided('approve')).patch.stage).toBe('pr');
  });

  it('after REWORK-SPEC, spec completes only once spec.md changed and was re-challenged', () => {
    const j = job('spec', 'running');
    const decision = art('decision.md', 'rework-spec', { specSha256: 's1' });
    expect(() => run(j, 'complete', { ...none, artifacts: [...passedSpec(), decision] })).toThrow(
      /REWORK-SPEC for this spec\.md/,
    );
    // Revised but not yet challenged: the challenge gate applies as usual.
    const revised = art('spec.md', null, { sha256: 's2' });
    const stale = [revised, art('spec-review-1.md', 'pass', { specSha256: 's1' }), decision];
    expect(() => run(j, 'complete', { ...none, artifacts: stale })).toThrow(/earlier spec\.md/);
    const fresh = [revised, art('spec-review-1.md', 'pass', { specSha256: 's2' }), decision];
    expect(run(j, 'complete', { ...none, artifacts: fresh }).patch.stage).toBe('build');
    // A REWORK-BUILD decision never holds spec back.
    const build = art('decision.md', 'rework-build', { specSha256: 's1' });
    expect(run(j, 'complete', { ...none, artifacts: [...passedSpec(), build] }).patch.stage).toBe(
      'build',
    );
  });

  it('after REWORK-SPEC, resume out of a spec escalation skips spec only once spec.md changed', () => {
    const blocked = job('needs-human', 'blocked', { returnStage: 'spec' });
    const decision = art('decision.md', 'rework-spec', { specSha256: 's1' });
    const unchanged = { ...none, artifacts: [...passedSpec(), decision] };
    for (const to of ['build', 'review', 'approve', 'pr'] as const) {
      expect(() => run(blocked, 'resume', { ...unchanged, to })).toThrow(
        /REWORK-SPEC for this spec\.md/,
      );
    }
    // Back to spec, explicitly or by default, is how the human answers it.
    expect(run(blocked, 'resume', unchanged).patch.stage).toBe('spec');
    expect(run(blocked, 'resume', { ...unchanged, to: 'spec' }).patch.stage).toBe('spec');
    // Revised and re-challenged: the resume to build goes through.
    const fresh = [
      art('spec.md', null, { sha256: 's2' }),
      art('spec-review-1.md', 'pass', { specSha256: 's2' }),
      decision,
    ];
    expect(run(blocked, 'resume', { ...none, artifacts: fresh, to: 'build' }).patch.stage).toBe(
      'build',
    );
    // REWORK-BUILD, or a REWORK-SPEC that judged another spec.md, never holds the resume back.
    for (const other of [
      art('decision.md', 'rework-build', { specSha256: 's1' }),
      art('decision.md', 'rework-spec', { specSha256: 's0' }),
    ]) {
      const artifacts = [...passedSpec(), other];
      expect(run(blocked, 'resume', { ...none, artifacts, to: 'build' }).patch.stage).toBe('build');
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
