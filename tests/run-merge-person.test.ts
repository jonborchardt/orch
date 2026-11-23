/**
 * A completed job whose merge only a person can unblock (decision
 * 2026-11-23-queue-passes-over-person-merge-blocks): the controller reports it as needs-human with
 * a step that works and goes on; `github-refused` is run-ending and still ends the run (decision
 * 2026-11-23-queue-ends-only-on-run-wide-outcomes). Uses
 * tests/run-fixture.ts; the workflow change is in the PR's file list on the gh shim.
 */
import { describe, expect, it } from 'vitest';

import { formatSummary, summaryExitCode } from '../src/cli/run.ts';
import { dispatchJob } from '../src/ops/dispatch.ts';
import { getJob } from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import {
  clone,
  done,
  eventsOf,
  finish,
  jobsOf,
  launcher,
  merges,
  one,
  queue,
  shim,
  status,
  store,
  ticket,
} from './run-fixture.ts';

const key = (id: number) => String(id).padStart(4, '0');

/** GitHub's file list for a PR that edits a workflow. */
const WORKFLOW_FILES = { files: [{ filename: '.github/workflows/ci.yml' }] };

/** A session that completes the job with a PR that changes .github/workflows/. */
const doneWithWorkflow = (job: Job): void => {
  finish(job, WORKFLOW_FILES);
};

describe('a merge only a person can unblock', () => {
  it('orch start reports it, passes it over, and runs the next ready ticket', async () => {
    const first = ticket('Touches CI', { priority: 'P1' });
    const second = ticket('Plain', { priority: 'P2' });
    const l = launcher(doneWithWorkflow, done);

    const s = await queue(l);

    const jobId = jobsOf(first)[0]?.id ?? '';
    const [human, merged] = s.tickets;
    expect(human).toMatchObject({ ticketId: first, outcome: 'needs-human', jobId });
    expect(human?.reason).toContain('workflow-changed');
    expect(human?.next).toContain('Merge on the dashboard');
    expect(human?.next).not.toContain('tries again');
    expect(merged).toMatchObject({ ticketId: second, outcome: 'done' });
    expect(status(second)).toBe('done');
    expect(s.reason).toBe('no ready ticket is left (1 waits for a person)');

    // Completed, unmerged, released, with the merge code on record.
    expect(getJob(store.db, jobId)).toMatchObject({
      stage: 'completed',
      status: 'completed',
      ownerSession: null,
    });
    expect(getJob(store.db, jobId).prState).not.toBe('merged');
    expect(status(first)).toBe('in-progress');
    expect(merges()).toHaveLength(1);
    expect(eventsOf(jobId, 'runner.stopped').at(-1)?.payload).toMatchObject({
      outcome: 'needs-human',
      code: 'workflow-changed',
      next: human?.next,
    });
    expect(summaryExitCode(s)).toBe(1);
    const text = formatSummary(s);
    expect(text).toContain(`${key(first)} needs-human:`);
    expect(text).toContain(`     next: ${human?.next ?? ''}`);
  });

  it('orch do ends at that one ticket with the same outcome and step', async () => {
    const id = ticket('Touches CI', { priority: 'P1' });
    const other = ticket('Other', { priority: 'P2' });
    const job = dispatchJob(store, { ticket: id, session: 'earlier', cwd: clone }).job;
    finish(job, WORKFLOW_FILES);
    const l = launcher(done);

    const s = await one(l, id);

    expect(s.tickets).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({ outcome: 'needs-human', jobId: job.id });
    expect(s.tickets[0]?.next).toContain('Merge on the dashboard');
    expect(s.tickets[0]?.next).not.toContain('tries again');
    expect(l.calls).toHaveLength(0);
    expect(jobsOf(other)).toHaveLength(0);
    expect(merges()).toHaveLength(0);
  });

  it('a refusal outside the set (github-refused) still ends the queue as blocked', async () => {
    const first = ticket('Refused', { priority: 'P1' });
    const second = ticket('Never started', { priority: 'P2' });
    shim.write({ fail: 'pr merge' });

    const s = await queue(launcher(done));

    expect(s.tickets).toHaveLength(1);
    expect(s.tickets[0]).toMatchObject({ ticketId: first, outcome: 'blocked' });
    expect(s.tickets[0]?.next).toContain('tries again');
    expect(s.reason).toContain(`ticket ${key(first)} is blocked: github-refused`);
    expect(jobsOf(second)).toHaveLength(0);
  });
});
