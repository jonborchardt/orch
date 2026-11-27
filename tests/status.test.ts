import { describe, expect, it } from 'vitest';

import { prPhase } from '../src/core/workflow.ts';
import {
  BLOCKER_EVENTS,
  blockerOf,
  ciSummary,
  outcomeOf,
  progressOf,
  timelineOf,
} from '../src/server/status.ts';
import type { CiView, Progress } from '../src/server/types.ts';
import type { Event, Job } from '../src/storage/schema.ts';

let seq = 0;
function ev(type: string, payload: Record<string, unknown> = {}): Event {
  seq++;
  return {
    id: seq,
    jobId: 'job-00000001',
    type,
    payload,
    actor: null,
    createdAt: `2026-11-17T08:${String(seq % 60).padStart(2, '0')}:00.000Z`,
  };
}

type Row = Pick<Job, 'stage' | 'status' | 'returnStage'>;
const row = (stage: Row['stage'], status: Row['status'], returnStage: Row['returnStage'] = null) =>
  ({ stage, status, returnStage }) satisfies Row;
/** Newest event per type, as the board's BLOCKER_EVENTS map holds them. */
const newest = (...events: Event[]) => new Map(events.map((e) => [e.type, e]));
const states = (p: Progress) => p.steps.map((s) => `${s.label}:${s.state}`).join(' ');

describe('progressOf and timelineOf', () => {
  it('(a) a pending spec job is at Spec; (b) review round 2 after changes is at Review', () => {
    const a = progressOf(row('spec', 'pending'), new Map(), []);
    expect(states(a)).toBe(
      'Spec:current Build:not-started Simplify:not-started Review:not-started Approve:not-started PR:not-started CI:not-started Done:not-started',
    );
    expect(a.label).toBe('Spec');
    const b = progressOf(row('review', 'running'), new Map(), []);
    expect(b.steps.map((s) => s.state).slice(0, 4)).toEqual(['done', 'done', 'done', 'current']);
    expect(b.label).toBe('Review');
  });

  it('(c) a CI escalation after repairs ran out is stopped at CI, not at its return stage', () => {
    const blocked = ev('job.blocked', { from: 'ci', reason: 'max CI repair cycles reached' });
    const p = progressOf(row('needs-human', 'blocked', 'build'), newest(blocked), []);
    expect(p.label).toBe('CI, needs human');
    expect(states(p)).toBe(
      'Spec:done Build:done Simplify:done Review:done Approve:done PR:done CI:stopped Done:not-started',
    );
  });

  it('(d) approve escalation, (e) interrupted build, (f) cancelled review, (g) completed', () => {
    const d = progressOf(
      row('needs-human', 'blocked', 'approve'),
      newest(ev('job.blocked', { from: 'approve' })),
      [],
    );
    expect(d.steps[4]).toMatchObject({ label: 'Approve', state: 'stopped' });
    expect(d.label).toBe('Approve, needs human');
    // Without the event, the return stage still places it.
    expect(progressOf(row('needs-human', 'blocked', 'approve'), new Map(), []).position).toBe(4);
    const e = progressOf(row('build', 'interrupted'), new Map(), []);
    expect(e.label).toBe('Build, interrupted');
    expect(e.steps[1]?.state).toBe('stopped');
    const f = progressOf(row('review', 'cancelled'), new Map(), []);
    expect(f.label).toBe('Review, cancelled');
    expect(f.steps[3]?.state).toBe('stopped');
    expect(f.steps[7]?.state).toBe('not-started');
    const g = progressOf(row('completed', 'completed'), new Map(), []);
    expect(g.steps.every((s) => s.state === 'done')).toBe(true);
    expect(g.label).toBe('Done');
  });

  it('a fast job has only Build, PR, CI, and Done steps', () => {
    const fast = { ...row('pr', 'running'), mode: 'fast' as const };
    expect(states(progressOf(fast, new Map(), []))).toBe(
      'Build:done PR:current CI:not-started Done:not-started',
    );
    const blocked = { ...row('needs-human', 'blocked', 'build'), mode: 'fast' as const };
    const p = progressOf(blocked, newest(ev('job.blocked', { from: 'ci' })), []);
    expect(p).toMatchObject({ position: 2, label: 'CI, needs human' });
    const done = progressOf(
      { ...row('completed', 'completed'), mode: 'fast' as const },
      new Map(),
      [],
    );
    expect(done).toMatchObject({ position: 4, label: 'Done' });
    expect(done.steps.map((s) => s.id)).toEqual(['build', 'pr', 'ci', 'done']);
  });

  it('(h) a rework from ci shows the current pass, and the timeline the loop in order', () => {
    const p = progressOf(row('build', 'pending'), new Map(), []);
    expect(states(p)).toBe(
      'Spec:done Build:current Simplify:not-started Review:not-started Approve:not-started PR:not-started CI:not-started Done:not-started',
    );
    const events = [
      ev('stage.started', { stage: 'spec' }),
      ev('stage.completed', { stage: 'spec', round: 0 }),
      ev('stage.started', { stage: 'build' }),
      ev('stage.completed', { stage: 'build', round: 0 }),
      ev('stage.started', { stage: 'simplify' }),
      ev('stage.completed', { stage: 'simplify', round: 1 }),
      ev('stage.started', { stage: 'review' }),
      ev('stage.completed', { stage: 'review', round: 1, changesRequestedBy: ['security'] }),
      ev('stage.started', { stage: 'build' }),
      ev('stage.completed', { stage: 'build', round: 1 }),
      ev('stage.started', { stage: 'review' }),
      ev('stage.completed', { stage: 'review', round: 2, changesRequestedBy: [], blocking: 0 }),
      ev('stage.started', { stage: 'approve' }),
      ev('stage.completed', { stage: 'approve', round: 2 }),
      ev('stage.started', { stage: 'pr' }),
      ev('stage.completed', { stage: 'pr', round: 2 }),
      ev('stage.started', { stage: 'ci' }),
      ev('job.reworked', { from: 'ci', reason: 'tests fail', ciRepairs: 1 }),
      ev('stage.started', { stage: 'build' }),
    ];
    const t = timelineOf(events);
    const labels = t.entries.map((x) => x.label);
    expect(labels.slice(4, 6)).toEqual(['Simplify started', 'Simplify completed']);
    expect(labels).toContain('Review round 1: changes requested, back to Build');
    expect(labels).toContain('Review round 2 passed');
    const ci = labels.indexOf('CI started');
    const rework = labels.indexOf('Rework from CI: back to Build');
    expect(ci).toBeGreaterThan(0);
    expect(rework).toBe(ci + 1);
    expect(labels.lastIndexOf('Build started')).toBe(rework + 1);
    expect(labels.filter((l) => l === 'Build started')).toHaveLength(3);
    expect(t.entries.map((x) => x.at)).toEqual(events.map((x) => x.createdAt));
    expect(t.truncated).toBe(false);
  });

  it('labels a last-round escalation and a cancel outside any step without inventing a step', () => {
    const t = timelineOf([
      ev('stage.started', { stage: 'review' }),
      ev('stage.completed', { stage: 'review', round: 3, changesRequestedBy: ['security'] }),
      ev('job.blocked', { from: 'review', reason: 'max review rounds reached' }),
      ev('job.cancelled', { stage: 'needs-human', reason: null }),
      ev('job.cancelled', {}),
    ]);
    expect(t.entries.map((x) => `${x.kind}:${x.label}`)).toEqual([
      'started:Review started',
      // Escalated in the same transition: it did not go back to Build.
      'completed:Review round 3: changes requested',
      'stopped:Review: needs human',
      'stopped:Cancelled',
      'stopped:Cancelled',
    ]);
    expect(timelineOf([ev('job.cancelled', { stage: 'pr' })]).entries[0]?.label).toBe(
      'Cancelled during PR',
    );
  });

  it('(i) an escalation with no recorded stage marks no step and says "Needs human"', () => {
    const p = progressOf(row('needs-human', 'blocked', null), new Map(), []);
    expect(p.position).toBe(-1);
    expect(p.label).toBe('Needs human');
    expect(p.steps.every((s) => s.state === 'not-started')).toBe(true);
    // Neither needs-human nor completed is ever a usable return stage.
    expect(progressOf(row('needs-human', 'blocked', 'completed'), new Map(), []).position).toBe(-1);
  });

  it('a simplify-stage job marks Simplify current', () => {
    for (const status of ['pending', 'running'] as const) {
      const p = progressOf(row('simplify', status), new Map(), []);
      expect(states(p)).toBe(
        'Spec:done Build:done Simplify:current Review:not-started Approve:not-started PR:not-started CI:not-started Done:not-started',
      );
      expect(p.label).toMatch(/^Simplify/);
      expect(p.label).not.toMatch(/Unknown/);
    }
    // The board sorts the Stage column by position: Simplify falls between Build and Review.
    const at = (stage: Row['stage']) => progressOf(row(stage, 'pending'), new Map(), []).position;
    expect([at('build'), at('simplify'), at('review')]).toEqual([1, 2, 3]);
  });

  it('(j) exactly 500 events marks the timeline truncated; step states never read it', () => {
    const many = Array.from({ length: 500 }, () => ev('stage.started', { stage: 'build' }));
    expect(timelineOf(many).truncated).toBe(true);
    expect(timelineOf(many.slice(1)).truncated).toBe(false);
  });

  it('never names needs-human or completed as a step: always the same eight, in order', () => {
    const blocked = newest(ev('job.blocked', { from: 'pr' }));
    const stages = [
      'spec',
      'build',
      'simplify',
      'review',
      'approve',
      'pr',
      'ci',
      'needs-human',
      'completed',
    ];
    const statuses = [
      'pending',
      'running',
      'blocked',
      'interrupted',
      'completed',
      'failed',
      'cancelled',
    ];
    for (const stage of stages) {
      for (const status of statuses) {
        for (const events of [new Map<string, Event>(), blocked]) {
          const p = progressOf(
            row(stage as Row['stage'], status as Row['status'], 'needs-human'),
            events,
            [],
          );
          expect(p.steps.map((s) => s.label)).toEqual([
            'Spec',
            'Build',
            'Simplify',
            'Review',
            'Approve',
            'PR',
            'CI',
            'Done',
          ]);
          expect(
            p.steps.filter((s) => s.state === 'current' || s.state === 'stopped').length,
          ).toBeLessThanOrEqual(1);
          expect(p.label).not.toMatch(/needs-human|completed/);
        }
      }
    }
    // A cancelled job never shows Done as reached.
    expect(progressOf(row('ci', 'cancelled'), new Map(), []).steps[7]?.state).toBe('not-started');
  });
});

describe('blockerOf and runner.stopped', () => {
  type BJob = Parameters<typeof blockerOf>[0];
  const idle = (over: Partial<BJob> = {}): BJob => ({
    stage: 'build',
    status: 'pending',
    leaseExpiresAt: null,
    ownerSession: null,
    round: 0,
    ciRepairs: 0,
    maxCiRepairs: 2,
    prState: null,
    ...over,
  });
  const reason = 'Two Claude sessions in a row changed nothing.';
  const stop = (over: Record<string, unknown> = {}) =>
    ev('runner.stopped', {
      outcome: 'blocked',
      code: 'no-progress',
      reason,
      stage: 'build',
      status: 'pending',
      next: 'orch do 0088',
      ...over,
    });
  const evidence = (...events: Event[]) => ({
    events: newest(...events),
    artifacts: [],
    latestRun: null,
  });
  const waiting = { kind: 'waiting', summary: 'No session owns this job', detail: null };

  it('AC1/AC5: an idle unowned job whose last news is the stop shows the stop', () => {
    expect(BLOCKER_EVENTS).toContain('runner.stopped');
    const b = blockerOf(idle(), 'idle', evidence(ev('ci.observed', {}), stop()));
    expect(b).toEqual({
      kind: 'stopped',
      summary: expect.stringContaining('no-progress') as string,
      detail: reason,
      next: 'orch do 0088',
    });
  });

  it('AC2: a newer loaded event, or a different stage or status, supersedes the stop', () => {
    expect(blockerOf(idle(), 'idle', evidence(stop(), ev('ci.observed', {})))).toEqual(waiting);
    expect(blockerOf(idle({ stage: 'review' }), 'idle', evidence(stop()))).toEqual(waiting);
    expect(blockerOf(idle(), 'idle', evidence(stop({ status: 'running' })))).toEqual(waiting);
  });

  it('AC3: a completed unmerged job shows a matching stop; a merged one shows nothing', () => {
    const done = idle({ stage: 'completed', status: 'completed', prState: 'ready' });
    const ended = evidence(
      ev('job.completed', {}),
      stop({ code: 'workflow-changed', stage: 'completed', status: 'completed', next: null }),
    );
    expect(blockerOf(done, 'completed', ended)).toMatchObject({
      kind: 'stopped',
      summary: expect.stringContaining('workflow-changed') as string,
      next: null,
    });
    expect(blockerOf({ ...done, prState: 'merged' }, 'completed', ended)).toBeNull();
  });

  it('AC4: blocked, failed, interrupted, cancelled and running blockers ignore the stop', () => {
    const cases = [
      ['needs-human', 'blocked', 'blocked'],
      ['build', 'failed', 'failed'],
      ['build', 'interrupted', 'interrupted'],
      ['build', 'cancelled', 'cancelled'],
      ['build', 'running', 'running'],
    ] as const;
    for (const [stage, status, state] of cases) {
      const job = idle({ stage, status, ownerSession: state === 'running' ? 's' : null });
      const without = blockerOf(job, state, evidence());
      expect(blockerOf(job, state, evidence(stop({ stage, status })))).toEqual(without);
    }
  });
});

function ci(over: Partial<CiView> = {}): Omit<CiView, 'line' | 'guidance'> {
  return {
    head: null,
    current: null,
    status: null,
    checkedAt: null,
    repairs: 0,
    maxRepairs: 2,
    outcome: null,
    reason: null,
    failures: [],
    completion: null,
    ...over,
  };
}

type JobBits = Parameters<typeof ciSummary>[1];
const noPr: JobBits = { id: 'job-00000001', stage: 'build', prUrl: null, prState: null };
const withPr = (over: Partial<JobBits> = {}): JobBits => ({
  id: 'job-00000001',
  stage: 'ci',
  prUrl: 'https://github.com/x/y/pull/9',
  prState: 'draft',
  ...over,
});
const line = (job: JobBits, over: Partial<CiView>) => ciSummary(ci(over), job).line;

describe('ciSummary', () => {
  it('describes every CI state from structured fields, never from a stale verdict', () => {
    expect(line(noPr, {})).toBe('No PR yet.');
    expect(line(withPr(), {})).toBe('PR created; CI not yet observed.');
    expect(line(withPr(), { head: 'a1b2c3d4', status: 'pending', current: true })).toBe(
      'CI pending for a1b2c3d.',
    );
    expect(line(withPr(), { head: 'a1b2c3d4', status: 'passing', current: true })).toBe(
      'CI passing for a1b2c3d.',
    );
    // A green verdict for a commit that is no longer HEAD is said to be stale, in so many words.
    expect(line(withPr(), { head: 'a1b2c3d4', status: 'passing', current: false })).toContain(
      'not the current HEAD',
    );
    expect(
      line(withPr({ stage: 'build' }), { head: 'a1b2c3d4', status: 'failing', repairs: 1 }),
    ).toBe('CI failed for a1b2c3d; repair in progress (1 of 2 repairs used, stage build).');
    expect(
      line(withPr({ stage: 'needs-human' }), { head: 'a1b2c3d4', status: 'failing', repairs: 2 }),
    ).toBe('CI still failing for a1b2c3d; 2 of 2 repairs used.');
    expect(line(withPr({ stage: 'needs-human' }), { head: 'a1b2c3d4', status: 'none' })).toBe(
      'GitHub reports no checks for a1b2c3d.',
    );
    expect(
      line(withPr({ stage: 'needs-human' }), {
        head: 'a1b2c3d4',
        status: 'failing',
        outcome: 'infrastructure',
      }),
    ).toContain('did not reach a verdict');
    expect(
      line(withPr({ stage: 'needs-human' }), {
        head: 'a1b2c3d4',
        status: 'pending',
        outcome: 'closed',
      }),
    ).toContain('closed without merging');
    expect(
      line(withPr({ stage: 'needs-human' }), {
        head: 'a1b2c3d4',
        status: 'passing',
        outcome: 'outdated',
      }),
    ).toContain('moved outside the job');
    expect(
      line(withPr({ stage: 'needs-human', prState: 'merged' }), {
        head: 'a1b2c3d4',
        status: 'failing',
      }),
    ).toContain('merged outside the factory');
    const finished = withPr({ stage: 'completed' });
    expect(line(finished, { head: 'a1b2c3d4', status: 'passing', completion: 'ci' })).toBe(
      'Completed: required checks passed for a1b2c3d.',
    );
    expect(line(finished, { head: 'a1b2c3d4', status: 'none', completion: 'human' })).toBe(
      'Completed by human close-out; CI was none for a1b2c3d.',
    );
    expect(line(finished, { completion: 'legacy' })).toContain('before the ci stage existed');
  });

  it('a released job is not being polled: the guidance says to resume it', () => {
    const pending = ci({ head: 'a1b2c3d4', status: 'pending', current: true });
    expect(ciSummary(pending, withPr({ ownerSession: 'claude-1' })).guidance).toContain(
      'the session polls with orch gh ci',
    );
    const released = ciSummary(pending, withPr({ ownerSession: null })).guidance;
    expect(released).toContain('No session is polling');
    expect(released).toContain('/factory job-00000001');
    expect(released).not.toContain('the session polls');
  });
});

describe('prPhase', () => {
  const pr = (over: Partial<Parameters<typeof prPhase>[0]> = {}) => ({
    prUrl: 'https://github.com/x/y/pull/9',
    prState: 'draft' as const,
    ciStatus: null,
    ...over,
  });
  it('names where the PR stands from recorded fields only', () => {
    expect(prPhase(pr({ prUrl: null, prState: null }), null)).toBe('no-pr');
    expect(prPhase(pr(), null)).toBe('draft');
    expect(prPhase(pr({ ciStatus: 'passing' }), null)).toBe('draft');
    expect(prPhase(pr({ ciStatus: 'pending' }), null)).toBe('ci-running');
    expect(prPhase(pr({ ciStatus: 'failing' }), null)).toBe('ci-failing');
    expect(prPhase(pr({ prState: 'ready', ciStatus: 'passing' }), 'ci')).toBe('ready-to-merge');
    // Ready on GitHub is not enough: only a completion on GitHub's verdict is ready to merge.
    expect(prPhase(pr({ prState: 'ready', ciStatus: 'passing' }), 'human')).toBe('draft');
    expect(prPhase(pr({ ciStatus: 'passing' }), 'ci')).toBe('ready-mark-failed');
    expect(prPhase(pr({ prState: 'merged', ciStatus: 'failing' }), null)).toBe('merged');
    expect(prPhase(pr({ prState: 'closed', ciStatus: 'passing' }), 'ci')).toBe('closed');
  });

  it('the completed-via-ci guidance names the phase', () => {
    const done = ci({ head: 'a1b2c3d4', status: 'passing', completion: 'ci' });
    const guide = (prState: JobBits['prState']) =>
      ciSummary(done, withPr({ stage: 'completed', prState })).guidance;
    expect(guide('ready')).toContain('Ready to merge');
    expect(guide('merged')).toBe('Merged.');
    expect(guide('draft')).toContain('Ready marking failed: run gh pr ready');
    expect(guide('closed')).toContain('closed without merging');
  });
});

describe('outcomeOf', () => {
  type PrBits = Parameters<typeof outcomeOf>[1];
  const pr = (over: Partial<PrBits> = {}): PrBits => ({
    prUrl: 'https://github.com/x/y/pull/9',
    prState: 'ready',
    ciStatus: 'passing',
    ...over,
  });
  const kind = (job: PrBits, completion: Parameters<typeof outcomeOf>[2]) =>
    outcomeOf('completed', job, completion)?.kind;

  it('names how a completed job ended, by precedence, from recorded fields only', () => {
    expect(kind(pr({ prState: 'merged' }), 'ci')).toBe('merged');
    // A human close-out whose PR was later merged: the merge is the headline.
    expect(kind(pr({ prState: 'merged', ciStatus: 'failing' }), 'human')).toBe('merged');
    // Ready PR on a passing verdict is ready, never merged (merged only from a recorded merge).
    expect(kind(pr(), 'ci')).toBe('ready');
    expect(kind(pr({ ciStatus: 'failing' }), 'human')).toBe('human');
    expect(kind(pr(), 'human')).toBe('human');
    // Not enough on record: a ci completion later observed failing, a draft or closed PR, legacy.
    expect(kind(pr({ ciStatus: 'failing' }), 'ci')).toBe('completed');
    expect(kind(pr({ prState: 'draft' }), 'ci')).toBe('completed');
    expect(kind(pr({ prState: 'closed' }), 'ci')).toBe('completed');
    expect(kind(pr({ prUrl: null, prState: null, ciStatus: null }), 'legacy')).toBe('completed');
    expect(kind(pr(), 'legacy')).toBe('completed');
  });

  it('labels each kind and is null for any job that is not completed', () => {
    expect(outcomeOf('completed', pr({ prState: 'merged' }), 'ci')?.label).toBe(
      'completed: merged',
    );
    expect(outcomeOf('completed', pr(), 'ci')?.label).toBe('completed: PR ready, checks passed');
    expect(outcomeOf('completed', pr(), 'human')?.label).toBe('completed: human close-out');
    expect(outcomeOf('completed', pr(), 'legacy')?.label).toBe('completed');
    for (const state of [
      'running',
      'stale',
      'idle',
      'interrupted',
      'failed',
      'blocked',
      'cancelled',
    ] as const) {
      expect(outcomeOf(state, pr({ prState: 'merged' }), null)).toBeNull();
    }
  });
});
