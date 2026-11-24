/**
 * Needs-human choices (ticket 0057): `orch job transition ... escalate --choice` records them on
 * `job.blocked`, and the dashboard's `answer` runs the action a choice maps to, then posts the
 * answer as a notice for the next session. The ticketed path through `orch do` is in
 * tests/run-evidence.test.ts; the HTTP route and the detail view are in tests/server.test.ts.
 */
import { tmpdir } from 'node:os';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../src/core/errors.ts';
import type { Choice, JobMode, Stage } from '../src/core/workflow.ts';
import { type ActionInput, dashboardAction } from '../src/ops/actions.ts';
import { eventsOfTypes, listEvents } from '../src/storage/events.ts';
import { claimJob, createJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { orch, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

/** A claimed job running in `stage` (set directly: no stage evidence is needed to escalate). */
function running(
  stage: Stage,
  mode: JobMode = 'full',
  extra: Partial<typeof jobs.$inferInsert> = {},
) {
  const { id } = createJob(store, {
    title: 'Choose',
    description: 'Pick one',
    repo: 'github.com/acme/alpha',
    repoPath: '/repos/alpha',
    baseBranch: 'main',
    mode,
  });
  store.db
    .update(jobs)
    .set({ stage, ...extra })
    .where(eq(jobs.id, id))
    .run();
  const { token } = claimJob(store, id, { session: 's' });
  transitionJob(store, id, 'start', { token });
  return { id, token };
}

function escalated(
  stage: Stage,
  choices: Choice[] | undefined,
  extra: Partial<typeof jobs.$inferInsert> = {},
) {
  const { id, token } = running(stage, 'full', extra);
  transitionJob(store, id, 'escalate', { token, reason: 'which way', choices });
  return id;
}

const cli = (...args: string[]) => orch(store.home, tmpdir(), args);
const blocked = (id: string) => eventsOfTypes(store.db, id, ['job.blocked']);
const types = (id: string) =>
  listEvents(store.db, id, 100)
    .map((e) => e.type)
    .filter((t) => t !== 'notice.posted');
const shape = (id: string) => {
  const j = getJob(store.db, id);
  return { stage: j.stage, status: j.status, round: j.round, maxRounds: j.maxRounds };
};

describe('orch job transition escalate --choice', () => {
  it('records the choices on the job.blocked event (AC1)', () => {
    const { id, token } = running('approve');
    const r = cli(
      'job',
      'transition',
      id,
      'escalate',
      '--reason',
      'r',
      '--choice',
      'resume:approve=Approve as is',
      '--choice',
      'cancel=Drop it',
      '--token',
      token,
    );
    expect(r.code, r.err).toBe(0);
    expect(blocked(id)[0]?.payload['choices']).toEqual([
      { kind: 'resume', to: 'approve', label: 'Approve as is' },
      { kind: 'cancel', label: 'Drop it' },
    ]);
  });

  it('refuses bad choices with exit 2 and leaves the job where it was (AC2)', () => {
    const { id, token } = running('approve');
    const before = getJob(store.db, id);
    const bad: string[][] = [
      ['merge=Ship'],
      ['resume=Go on'],
      ['resume:needs-human=Wait'],
      ['resume:completed=Done'],
      ['cancel=  '],
      ['cancel=Same', 'rework=Same'],
      [`cancel=${'x'.repeat(121)}`],
      ['rework=a', 'rework=b', 'rework=c', 'rework=d', 'rework=e', 'rework=f'],
    ];
    for (const choices of bad) {
      const args = choices.flatMap((c) => ['--choice', c]);
      const r = cli(
        'job',
        'transition',
        id,
        'escalate',
        '--reason',
        'r',
        ...args,
        '--token',
        token,
      );
      expect(r.code, choices.join(' ')).toBe(2);
    }
    const fail = cli('job', 'transition', id, 'fail', '--choice', 'cancel=x', '--token', token);
    expect(fail.code).toBe(2);
    expect(fail.err).toContain('--choice is only for the escalate action');
    expect(getJob(store.db, id)).toEqual(before);
    expect(blocked(id)).toHaveLength(0);
  });

  it('refuses a fast job a choice it can never take: exit 1, nothing written (AC13)', () => {
    const { id, token } = running('build', 'fast');
    const before = getJob(store.db, id);
    const r = cli(
      'job',
      'transition',
      id,
      'escalate',
      '--choice',
      'resume:approve=Approve',
      '--token',
      token,
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('a fast job resumes only to build, pr, ci, completed');
    expect(blocked(id)).toHaveLength(0);
    expect(getJob(store.db, id)).toMatchObject({ stage: before.stage, status: before.status });
  });

  it('records no choices key without --choice (AC3)', () => {
    const { id, token } = running('approve');
    transitionJob(store, id, 'escalate', { token, reason: 'r' });
    expect(blocked(id)[0]?.payload).toEqual({ from: 'approve', reason: 'r' });
  });
});

describe('dashboard answer', () => {
  it('resumes to the chosen stage, releases, and posts the answer as a notice (AC5)', () => {
    const id = escalated('approve', [
      { kind: 'resume', to: 'approve', label: 'Approve as is' },
      { kind: 'cancel', label: 'Drop it' },
    ]);
    const r = dashboardAction(store, id, { action: 'answer', choice: 0, reason: 'ship it' });
    expect(r.job).toMatchObject({ stage: 'approve', status: 'pending', ownerSession: null });
    const notice = eventsOfTypes(store.db, id, ['notice.posted'])[0];
    expect(notice?.payload['text']).toBe('Human answered "Approve as is": ship it');
    expect(notice?.actor).toBe('dashboard');
    expect(eventsOfTypes(store.db, id, ['job.resumed'])[0]?.payload).toMatchObject({
      to: 'approve',
    });
    // Unticketed: the resume command; a ticketed job names orch do (tests/run-evidence.test.ts).
    expect(r.resumeCommand).toBe(`orch factory resume ${id} --session <name>`);
    expect(r.message).toContain('Answered "Approve as is"');
  });

  const twins: [string, Choice['kind'], ActionInput['action']][] = [
    ['rework', 'rework', 'request-rework'],
    ['review', 'review', 'request-review'],
    ['cancel', 'cancel', 'cancel'],
  ];
  it.each(twins)(
    'a %s choice does what the action it maps to does (AC6)',
    (_name, kind, action) => {
      const answered = escalated('approve', [{ kind, label: `Do ${kind}` }], { round: 1 });
      const direct = escalated('approve', undefined, { round: 1 });
      dashboardAction(store, answered, { action: 'answer', choice: 0 });
      dashboardAction(store, direct, { action, reason: 'x' });
      expect(shape(answered)).toEqual(shape(direct));
      expect(types(answered)).toEqual(types(direct));
      const notices = eventsOfTypes(store.db, answered, ['notice.posted']);
      if (kind === 'cancel') {
        expect(notices).toHaveLength(0);
        expect(eventsOfTypes(store.db, answered, ['job.cancelled'])[0]?.payload['reason']).toBe(
          'dashboard: answer "Do cancel"',
        );
      } else {
        expect(notices.map((n) => n.payload['text'])).toEqual([`Human answered "Do ${kind}"`]);
      }
    },
  );

  it('refuses an out-of-range index, a job not in needs-human, and an action the workflow refuses (AC7)', () => {
    const id = escalated('approve', [{ kind: 'cancel', label: 'Drop it' }]);
    const before = getJob(store.db, id);
    for (const choice of [1, -1, undefined]) {
      expect(() => dashboardAction(store, id, { action: 'answer', choice })).toThrow(
        ValidationError,
      );
    }
    expect(getJob(store.db, id)).toEqual(before);

    // Answered once, the job left needs-human: the old choices are no longer offered.
    const resumed = escalated('approve', [{ kind: 'rework', label: 'Again' }]);
    dashboardAction(store, resumed, { action: 'approve', reason: 'go' });
    const moved = getJob(store.db, resumed);
    expect(() => dashboardAction(store, resumed, { action: 'answer', choice: 0 })).toThrow(
      /needs-human with recorded choices/,
    );
    expect(getJob(store.db, resumed)).toEqual(moved);

    // A close-out while CI is failing is refused by accept-delivery's own rule.
    const failing = escalated('ci', [{ kind: 'accept-delivery', label: 'Close it out' }], {
      prUrl: 'https://github.com/acme/alpha/pull/1',
      ciHead: 'a'.repeat(40),
      ciStatus: 'failing',
      prState: 'draft',
    });
    const held = getJob(store.db, failing);
    expect(() => dashboardAction(store, failing, { action: 'answer', choice: 0 })).toThrow(
      /Cannot accept delivery: required checks are failing/,
    );
    expect(getJob(store.db, failing)).toEqual(held);
  });
});
