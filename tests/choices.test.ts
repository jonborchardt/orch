/**
 * Default needs-human choices (ticket 0132): the pure rule, the choices every `job.blocked` the
 * transition emits records (tests/workflow.test.ts), the `currentChoices` fallback for an event that recorded none, and
 * the detail view's after-action line read from the runner's state files. The controller's
 * retake is in tests/run-retake.test.ts.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ticketKey } from '../src/core/tickets.ts';
import {
  type Choice,
  defaultChoices,
  MAX_CI_REPAIRS_REASON,
  MAX_ROUNDS_REASON,
  SCOPE_GAP_REASON,
  type Stage,
  withDefaultChoice,
} from '../src/core/workflow.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { acquireRunnerLock, type RunnerSession, writeSession } from '../src/ops/runner-state.ts';
import { detail } from '../src/server/api.ts';
import { appendEvent } from '../src/storage/events.ts';
import { claimJob, createJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { createTicket } from '../src/storage/tickets.ts';
import { makeRepo, type TempStore, tempStore } from './helpers.ts';

const CONTINUING = ['resume', 'rework', 'review', 'accept-policy'];

describe('defaultChoices', () => {
  const full = (returnStage: Stage, reason: string | null) =>
    defaultChoices({ mode: 'full', returnStage }, reason);

  it('makes a stage the reason names the primary choice', () => {
    expect(full('approve', 'Resume to build to re-run build/simplify')[0]).toEqual({
      kind: 'resume',
      to: 'build',
      label: 'Send back to build',
    });
    for (const [reason, to] of [
      ['a human resume --to ci', 'ci'],
      ['RESUMES --TO pr later', 'pr'],
      ['resume to spec', 'spec'],
    ] as const) {
      expect(full('approve', reason)[0]?.to, reason).toBe(to);
    }
  });

  it('falls back to returnStage when the reason names no stage', () => {
    expect(full('approve', 'two designs are possible')).toEqual([
      { kind: 'resume', to: 'approve', label: 'Retry approve' },
      { kind: 'cancel', label: 'Cancel' },
    ]);
    expect(full('simplify', null)[0]?.label).toBe('Send back to simplify');
    expect(defaultChoices({ returnStage: null }, null)[0]?.to).toBe('build');
  });

  it('maps --to completed to accept-delivery, keeping a continuing choice', () => {
    const c = full('ci', 'accepts delivery without CI with resume --to completed');
    expect(c[0]).toEqual({ kind: 'accept-delivery', label: 'Accept delivery' });
    expect(c[1]).toEqual({ kind: 'resume', to: 'ci', label: 'Retry ci' });
  });

  it('never gives a fast job a stage outside its resume targets', () => {
    for (const reason of ['resume --to spec', 'resume to review', 'resume to approve', null]) {
      for (const back of ['build', 'pr', 'ci'] as const) {
        const c = defaultChoices({ mode: 'fast', returnStage: back }, reason);
        for (const x of c.filter((x) => x.to !== undefined)) {
          expect(['build', 'pr', 'ci', 'completed'], `${String(reason)} ${back}`).toContain(x.to);
        }
        expect(c[0]).toMatchObject({ kind: 'resume', to: back });
      }
    }
    expect(
      defaultChoices({ mode: 'fast', returnStage: 'ci' }, MAX_ROUNDS_REASON),
    ).not.toContainEqual(expect.objectContaining({ to: 'review' }));
  });

  it('always offers a continuing kind, ends with Cancel, and repeats no label', () => {
    const reasons = [
      null,
      'free text',
      'resume --to completed',
      'resume --to needs-human',
      'resume to nowhere',
      MAX_ROUNDS_REASON,
      MAX_CI_REPAIRS_REASON,
      SCOPE_GAP_REASON,
      'verification policy needs human acceptance',
    ];
    const stages: Stage[] = ['spec', 'build', 'simplify', 'review', 'approve', 'pr', 'ci'];
    for (const mode of ['full', 'fast'] as const) {
      for (const returnStage of stages) {
        for (const reason of reasons) {
          const c = defaultChoices({ mode, returnStage }, reason);
          const what = `${mode} ${returnStage} ${String(reason)}`;
          expect(
            c.some((x) => CONTINUING.includes(x.kind)),
            what,
          ).toBe(true);
          expect(c.at(-1), what).toEqual({ kind: 'cancel', label: 'Cancel' });
          expect(new Set(c.map((x) => x.label)).size, what).toBe(c.length);
        }
      }
    }
  });

  it('adds the buttons a known reason implies', () => {
    expect(full('build', MAX_ROUNDS_REASON).map((c) => c.label)).toEqual([
      'Send back to build',
      'Retry review',
      'Cancel',
    ]);
    expect(full('build', 'the verification policy changed').map((c) => c.kind)).toEqual([
      'resume',
      'accept-policy',
      'cancel',
    ]);
  });
});

describe('withDefaultChoice', () => {
  const defaults = defaultChoices({ returnStage: 'approve' }, null);
  it('keeps recorded choices that continue the job, and puts the primary before the rest', () => {
    const go: Choice[] = [{ kind: 'rework', label: 'Again' }];
    expect(withDefaultChoice(go, defaults)).toEqual(go);
    expect(withDefaultChoice([{ kind: 'cancel', label: 'Drop' }], defaults)).toEqual([
      { kind: 'resume', to: 'approve', label: 'Retry approve' },
      { kind: 'cancel', label: 'Drop' },
    ]);
    expect(withDefaultChoice(undefined, defaults)).toEqual(defaults);
  });
});

let store: TempStore;
beforeEach(() => {
  store = tempStore();
});
afterEach(() => {
  store.cleanup();
});

/** A job waiting in needs-human whose only job.blocked event is `payload`, as an older one was. */
function olderBlock(
  payload: Record<string, unknown>,
  repoPath = '/repos/alpha',
  ticketId?: number,
) {
  const job = createJob(store, {
    title: 'Older',
    description: 'escalated before default choices',
    repo: 'github.com/acme/alpha',
    repoPath,
    baseBranch: 'main',
    ...(ticketId === undefined ? {} : { ticketId }),
  });
  store.db
    .update(jobs)
    .set({ stage: 'needs-human', status: 'blocked', returnStage: 'approve', round: 1 })
    .where(eq(jobs.id, job.id))
    .run();
  appendEvent(store.db, job.id, 'job.blocked', payload, null, new Date().toISOString());
  return job.id;
}

describe('currentChoices fallback (AC2)', () => {
  it('derives choices for a job.blocked that recorded none, and answering the first resumes there', () => {
    const id = olderBlock({ from: 'approve', reason: 'Resume to build to re-run build/simplify' });
    const d = detail(store, id);
    expect(d.choices?.[0]).toEqual({
      kind: 'resume',
      to: 'build',
      label: 'Send back to build',
      action: 'approve',
      available: true,
    });
    expect(d.actions).toContain('answer');

    dashboardAction(store, id, { action: 'answer', choice: 0 });
    expect(getJob(store.db, id)).toMatchObject({
      stage: 'build',
      status: 'pending',
      ownerSession: null,
      ownerToken: null,
    });
  });

  it('returns recorded choices that continue the job unchanged', () => {
    const recorded: Choice[] = [
      { kind: 'review', label: 'Look again' },
      { kind: 'cancel', label: 'Drop it' },
    ];
    const id = olderBlock({ from: 'approve', reason: 'resume to build', choices: recorded });
    expect(detail(store, id).choices?.map(({ kind, label }) => ({ kind, label }))).toEqual(
      recorded,
    );
  });

  it('puts the derived primary in front of recorded choices that are only cancel', () => {
    const id = olderBlock({
      from: 'approve',
      reason: 'which way',
      choices: [{ kind: 'cancel', label: 'Drop it' }],
    });
    expect(detail(store, id).choices?.map((c) => c.label)).toEqual(['Retry approve', 'Drop it']);
  });
});

describe('the after-action line (AC6)', () => {
  let repo: string;
  let other: string;
  let ticketId: number;
  let id: string;
  let release: (() => void) | null = null;
  beforeEach(() => {
    repo = makeRepo();
    other = makeRepo();
    ticketId = createTicket(store, {
      title: 'T',
      repo: 'github.com/acme/alpha',
      repoPath: repo,
    }).id;
    id = olderBlock({ from: 'approve', reason: 'which way' }, repo, ticketId);
  });
  afterEach(() => {
    release?.();
    release = null;
  });

  /** Runner state as `run.ts` leaves it: a held lock and a session record with results. */
  function controller(over: Partial<RunnerSession>): void {
    release = acquireRunnerLock(store.paths);
    const ts = new Date().toISOString();
    writeSession(store.paths, {
      pid: process.pid,
      startedAt: ts,
      beatAt: ts,
      mode: 'queue',
      repo: null,
      ticket: null,
      ticketId: null,
      jobId: null,
      child: null,
      results: [
        {
          ticketId,
          title: 'T',
          repo: 'github.com/acme/alpha',
          jobId: id,
          outcome: 'needs-human',
          code: 'needs-human',
          reason: 'waits',
          relands: 0,
          next: null,
        },
      ],
      skipped: [],
      finished: null,
      ...over,
    });
  }
  const line = () => detail(store, id).afterAction ?? '';

  it('says the controller continues it for a running queue controller that passed the ticket over', () => {
    controller({});
    expect(line()).toBe('the controller continues it');
    release?.();
    release = null;
    controller({ repo });
    expect(line()).toBe('the controller continues it');
    // The action result says the same.
    const r = dashboardAction(store, id, { action: 'answer', choice: 0 });
    expect(r.message).toContain('The controller continues it.');
  });

  it('says run orch do NNNN when the controller is idle', () => {
    expect(line()).toBe(`no session is running it; run orch do ${ticketKey(ticketId)}`);
    const r = dashboardAction(store, id, { action: 'answer', choice: 0 });
    expect(r.message).toContain(`run orch do ${ticketKey(ticketId)}`);
    expect(r.resumeCommand).toBe(`orch do ${ticketKey(ticketId)}`);
  });

  it('says run orch do NNNN while orch do runs another ticket', () => {
    controller({ mode: 'ticket', ticket: ticketId + 1 });
    expect(line()).toContain(`run orch do ${ticketKey(ticketId)}`);
  });

  it('says run orch do NNNN when the queue is filtered to another repository', () => {
    controller({ repo: other });
    expect(line()).toContain(`run orch do ${ticketKey(ticketId)}`);
  });

  it('says run orch do NNNN when the queue session never saw the ticket', () => {
    controller({ results: [] });
    expect(line()).toContain(`run orch do ${ticketKey(ticketId)}`);
  });

  it('says run orch do NNNN for a person-merge needs-human result, and null outside needs-human', () => {
    controller({
      results: [
        {
          ticketId,
          title: 'T',
          repo: 'github.com/acme/alpha',
          jobId: id,
          outcome: 'needs-human',
          code: 'workflow-changed',
          reason: 'merge needs a person',
          relands: 0,
          next: null,
        },
      ],
    });
    expect(line()).toContain(`run orch do ${ticketKey(ticketId)}`);
    const { token } = claimJob(store, id, { session: 's' });
    transitionJob(store, id, 'resume', { token, to: 'build' });
    expect(detail(store, id).afterAction).toBeNull();
  });
});
