/**
 * Accepting a verification policy on the dashboard (ticket 0121): a job waiting in needs-human goes
 * back to the stage it was escalated from, released, so the controller's `orch do` continues it.
 */
import { describe, expect, it } from 'vitest';

import { jobArtifactDir } from '../src/core/paths.ts';
import { ticketKey } from '../src/core/tickets.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { RUNNER_SESSION } from '../src/ops/run.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import { type Ctx, go, head, passRound, passSpec, POLICY, start, toReview } from './drive.ts';
import { commitFile } from './helpers.ts';
import {
  type Act,
  clone,
  done,
  eventsOf,
  jobsOf,
  launcher,
  one,
  store,
  ticket,
} from './run-fixture.ts';

const STRONGER = JSON.stringify({
  verification: {
    commands: [
      ...POLICY.verification.commands,
      { id: 'types', command: 'node', args: ['-e', '0'] },
    ],
  },
});

/** A session that reaches build, proposes a stronger policy, escalates, and exits holding the job. */
const proposePolicy: Act = (job) => {
  const { token } = claimJob(store, job.id, { session: RUNNER_SESSION });
  const c: Ctx = {
    id: job.id,
    token,
    dir: jobArtifactDir(job.id, store.paths),
    wt: job.worktreePath ?? '',
  };
  passSpec(store, c);
  go(store, c, 'start');
  commitFile(c.wt, 'factory.json', STRONGER);
  go(store, c, 'escalate', 'verification policy needs human acceptance');
};

describe('accept-policy on a job waiting in needs-human', () => {
  it('returns a ticket job to build, released, and orch do continues it', async () => {
    const id = ticket('Policy change');
    const l = launcher(proposePolicy, done);

    const s = await one(l, id);
    const jobId = jobsOf(id)[0]?.id ?? '';
    expect(s.tickets[0]).toMatchObject({ outcome: 'needs-human', jobId });
    expect(getJob(store.db, jobId)).toMatchObject({ stage: 'needs-human', returnStage: 'build' });

    const r = dashboardAction(store, jobId, { action: 'accept-policy' });

    const job = getJob(store.db, jobId);
    expect(job).toMatchObject({
      stage: 'build',
      status: 'pending',
      returnStage: null,
      ownerSession: null,
      ownerToken: null,
      policyHead: head(job.worktreePath ?? ''),
    });
    const authorized = eventsOf(jobId, 'policy.authorized')[0]?.id ?? -1;
    expect(authorized).toBeGreaterThan(0);
    expect(eventsOf(jobId, 'job.resumed')[0]?.id).toBeGreaterThan(authorized);
    expect(eventsOf(jobId, 'job.resumed')[0]?.payload).toMatchObject({ to: 'build' });
    expect(r.message).toContain('returned to build (pending)');
    expect(r.message).toContain(`orch do ${ticketKey(id)}`);
    expect(r.resumeCommand).toBe(`orch do ${ticketKey(id)}`);

    const again = await one(l, id);

    expect(l.calls.map((c) => c.jobId)).toEqual([jobId, jobId]);
    expect(again.tickets[0]).toMatchObject({ outcome: 'done', jobId });
    expect(eventsOf(jobId, 'runner.session').at(-1)?.payload).toMatchObject({ moved: true });
  });

  it('returns a job escalated from approve to approve, maxRounds unchanged', () => {
    const c = start(store, clone);
    toReview(store, c);
    passRound(store, c);
    go(store, c, 'start');
    commitFile(c.wt, 'factory.json', STRONGER);
    go(store, c, 'escalate', 'verification policy needs human acceptance');
    const rounds = getJob(store.db, c.id).maxRounds;

    const r = dashboardAction(store, c.id, { action: 'accept-policy' });

    expect(getJob(store.db, c.id)).toMatchObject({
      stage: 'approve',
      status: 'pending',
      maxRounds: rounds,
      ownerSession: null,
    });
    expect(eventsOf(c.id, 'job.resumed').map((e) => e.payload)).toMatchObject([{ to: 'approve' }]);
    expect(r.message).toContain('returned to approve (pending)');
    expect(r.message).toContain(`orch factory resume ${c.id}`);
  });

  it('leaves a spec escalation in needs-human with its policy authorized', () => {
    const c = start(store, clone);
    go(store, c, 'start');
    commitFile(c.wt, 'factory.json', STRONGER);
    go(store, c, 'escalate', 'verification policy needs human acceptance');

    const r = dashboardAction(store, c.id, { action: 'accept-policy' });

    expect(getJob(store.db, c.id)).toMatchObject({
      stage: 'needs-human',
      status: 'blocked',
      returnStage: 'spec',
    });
    expect(getJob(store.db, c.id).policyHead).toBe(head(c.wt));
    expect(eventsOf(c.id, 'job.resumed')).toHaveLength(0);
    expect(r.message).not.toContain('returned to');
  });
});

describe('accept-policy outside needs-human', () => {
  it('changes neither stage nor status and keeps the message', () => {
    const c = start(store, clone);
    passSpec(store, c);
    commitFile(c.wt, 'factory.json', STRONGER);
    releaseJob(store, c.id, { token: c.token });

    const r = dashboardAction(store, c.id, { action: 'accept-policy' });

    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'build', status: 'pending' });
    expect(eventsOf(c.id, 'job.resumed')).toHaveLength(0);
    expect(eventsOf(c.id, 'policy.authorized')).toHaveLength(1);
    expect(r.message).toMatch(/^Verification policy from factory\.json at \w{7} accepted/);
    expect(r.message).toContain('the next orch verify uses the accepted checks.');
    expect(r.message).not.toContain('returned to');
    expect(r.resumeCommand).toBe(`orch factory resume ${c.id} --session <name>`);
  });
});
