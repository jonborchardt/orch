/**
 * The queue takes a passed-over escalation again in the same session once a person moved its job
 * on (ticket 0132, decision 2026-11-24-default-needs-human-choices). The person's dashboard
 * action happens while the controller runs the next ticket, inside that ticket's stand-in Claude
 * child. Uses tests/run-fixture.ts.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { dashboardAction } from '../src/ops/actions.ts';
import { RUNNER_SESSION, startSession } from '../src/ops/run.ts';
import { detail } from '../src/server/api.ts';
import { appendEvent } from '../src/storage/events.ts';
import { claimJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import { type Job, jobs } from '../src/storage/schema.ts';
import {
  type Act,
  done,
  finish,
  jobsOf,
  launcher,
  queue,
  quick,
  status,
  store,
  ticket,
} from './run-fixture.ts';

const escalate: Act = (job) => {
  const { token } = claimJob(store, job.id, { session: RUNNER_SESSION });
  transitionJob(store, job.id, 'start', { token });
  transitionJob(store, job.id, 'escalate', { token, reason: 'two designs are possible' });
};
const jobOf = (ticketId: number): Job => {
  const j = jobsOf(ticketId)[0];
  if (j === undefined) throw new Error(`ticket ${String(ticketId)} has no job`);
  return j;
};
/** A person answers the first choice on the dashboard; the answered job must come back released. */
const answer = (ticketId: number): void => {
  const id = jobOf(ticketId).id;
  dashboardAction(store, id, { action: 'answer', choice: 0 });
  expect(getJob(store.db, id)).toMatchObject({
    status: 'pending',
    ownerSession: null,
    ownerToken: null,
  });
};

describe('the queue takes a decided escalation again', () => {
  it('runs the ticket a person sent back again before the session ends', async () => {
    const a = ticket('Escalates', { priority: 'P1' });
    const b = ticket('Plain', { priority: 'P2' });
    const l = launcher(
      escalate,
      (job) => {
        answer(a);
        finish(job);
      },
      done,
    );

    const s = await queue(l);

    const jobA = jobOf(a).id;
    expect(l.calls.map((c) => c.jobId)).toEqual([jobA, jobOf(b).id, jobA]);
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [b, 'done'],
      [a, 'done'],
    ]);
    expect(status(a)).toBe('done');
    expect(s.reason).toBe('no ready ticket is left');
  });

  it('leaves a job still in needs-human, and a cancelled one, passed over', async () => {
    const a = ticket('Waits', { priority: 'P1' });
    const c = ticket('Gets cancelled', { priority: 'P2' });
    const b = ticket('Plain', { priority: 'P3' });
    const l = launcher(escalate, escalate, (job) => {
      dashboardAction(store, jobOf(c).id, { action: 'cancel', reason: 'not needed' });
      finish(job);
    });

    const s = await queue(l);

    expect(l.calls.map((x) => x.jobId)).toEqual([jobOf(a).id, jobOf(c).id, jobOf(b).id]);
    expect(getJob(store.db, jobOf(a).id).stage).toBe('needs-human');
    expect(getJob(store.db, jobOf(c).id).status).toBe('cancelled');
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [a, 'needs-human'],
      [c, 'needs-human'],
      [b, 'done'],
    ]);
    expect(s.reason).toBe('no ready ticket is left (2 waits for a person)');
  });

  it('takes an accepted delivery again and hands its job to mergeJob', async () => {
    const a = ticket('No CI', { priority: 'P1' });
    const b = ticket('Plain', { priority: 'P2' });
    // A session that reached ci on a PR with no checks and escalated, as orch gh ci does.
    const noChecks: Act = (job) => {
      const finished = finish(job);
      store.db
        .update(jobs)
        .set({ stage: 'needs-human', status: 'blocked', returnStage: 'ci', ciStatus: 'none' })
        .where(eq(jobs.id, finished.id))
        .run();
      appendEvent(
        store.db,
        job.id,
        'job.blocked',
        {
          from: 'ci',
          reason: 'no required checks; a human accepts delivery with resume --to completed',
        },
        null,
        new Date().toISOString(),
      );
    };
    const lines: string[] = [];
    const l = launcher(noChecks, (job) => {
      const id = jobOf(a).id;
      dashboardAction(store, id, { action: 'answer', choice: 0 });
      expect(getJob(store.db, id)).toMatchObject({ stage: 'completed', ownerSession: null });
      finish(job);
    });

    const s = await startSession(
      store,
      { mode: 'queue', repo: null },
      { launch: l.launch, ...quick, log: (line) => lines.push(line) },
    );

    const jobA = jobOf(a).id;
    // No second Claude session: the completed job goes straight to the merge.
    expect(l.calls.map((c) => c.jobId)).toEqual([jobA, jobOf(b).id]);
    const retaken = lines.findIndex((x) => x.startsWith(`ticket ${key(a)} taken again`));
    expect(retaken).toBeGreaterThan(0);
    expect(lines.slice(retaken).some((x) => x.startsWith('  merge: '))).toBe(true);
    expect(s.tickets.find((t) => t.ticketId === a)?.code).not.toBe('needs-human');
  });

  it('does not take again a ticket whose merge only a person can make', async () => {
    const a = ticket('Touches CI', { priority: 'P1' });
    const b = ticket('Plain', { priority: 'P2' });
    const l = launcher((job) => {
      finish(job, { files: [{ filename: '.github/workflows/ci.yml' }] });
    }, done);

    const s = await queue(l);

    expect(l.calls).toHaveLength(2);
    expect(s.tickets.map((t) => [t.ticketId, t.outcome, t.code])).toEqual([
      [a, 'needs-human', 'workflow-changed'],
      [b, 'done', 'done'],
    ]);
    // The job stays completed: Merge is its first action, and the blocker shows the next step.
    const d = detail(store, jobOf(a).id);
    expect(d.choices).toBeNull();
    expect(d.actions[0]).toBe('merge');
    expect(d.blocker?.next).toBe(s.tickets[0]?.next);
  });

  it('passes a retaken ticket that escalates again over again, and still ends', async () => {
    const a = ticket('Escalates twice', { priority: 'P1' });
    const b = ticket('Plain', { priority: 'P2' });
    const l = launcher(
      escalate,
      (job) => {
        answer(a);
        finish(job);
      },
      escalate,
    );

    const s = await queue(l);

    const jobA = jobOf(a).id;
    expect(l.calls.map((c) => c.jobId)).toEqual([jobA, jobOf(b).id, jobA]);
    expect(getJob(store.db, jobA)).toMatchObject({ stage: 'needs-human', ownerSession: null });
    expect(s.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([
      [b, 'done'],
      [a, 'needs-human'],
    ]);
    expect(s.reason).toBe('no ready ticket is left (1 waits for a person)');
  });
});

const key = (id: number) => String(id).padStart(4, '0');
