/**
 * A ticket whose job waits in needs-human (ticket 0174): the controller's stop line, the session
 * summary, and `orch status` lead with what is needed and give one `?choose=<n>` link per
 * available choice, in `currentChoices` order; the recorded reason is unchanged and follows.
 */
import { describe, expect, it } from 'vitest';

import { formatStatus } from '../src/cli/run.ts';
import { ticketKey } from '../src/core/tickets.ts';
import { currentChoices } from '../src/ops/actions.ts';
import { RUNNER_SESSION, runnerStatus, startSession } from '../src/ops/run.ts';
import { formatSummary } from '../src/ops/run-report.ts';
import { claimJob, getJob, transitionJob } from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import { eventsOf, jobsOf, launcher, quick, store, ticket } from './run-fixture.ts';

const escalate = (job: Job): void => {
  const { token } = claimJob(store, job.id, { session: RUNNER_SESSION });
  transitionJob(store, job.id, 'start', { token });
  transitionJob(store, job.id, 'escalate', {
    token,
    reason: 'two designs are possible',
    choices: [
      { kind: 'resume', to: 'spec', label: 'Rewrite the spec' },
      { kind: 'cancel', label: 'Drop the job' },
    ],
  });
};

describe('a needs-human stop', () => {
  it('prints what is needed, a link per choice, then the recorded reason; the summary and orch status do the same', async () => {
    const id = ticket('Two designs');
    const log: string[] = [];

    const s = await startSession(
      store,
      { mode: 'ticket', ticket: id },
      { launch: launcher(escalate).launch, log: (line) => log.push(line), ...quick },
    );

    const jobId = jobsOf(id)[0]?.id ?? '';
    const key = ticketKey(id);
    const labels = (currentChoices(store, getJob(store.db, jobId)) ?? []).map((c) => c.label);
    expect(labels).toEqual(['Rewrite the spec', 'Drop the job']);
    const links = labels.map((_, n) => `http://127.0.0.1:4777/#/jobs/${jobId}?choose=${String(n)}`);
    const result = s.tickets[0];
    const reason = result?.reason ?? '';
    expect(reason).toBe(`job ${jobId} waits for a person at spec: two designs are possible`);

    // The stop line: what is needed, one indented line per choice, then the recorded reason.
    const at = log.findIndex((l) => l.startsWith(`  ticket ${key}: needs-human: `));
    expect(log.slice(at, at + 4)).toEqual([
      `  ticket ${key}: needs-human: The spec needs a decision from a person: pick "Rewrite the spec" or "Drop the job".`,
      `    Rewrite the spec: the job goes back to spec and carries on from there. ${links[0] ?? ''}`,
      `    Drop the job: the job ends for good; its branch and worktree are kept. ${links[1] ?? ''}`,
      `    reason: ${reason}`,
    ]);
    // Only what is printed changed: the result and the runner.stopped event keep the reason.
    expect(eventsOf(jobId, 'runner.stopped').map((e) => e.payload['reason'])).toEqual([reason]);

    // The summary lists the same labels and links, before the reason.
    const text = formatSummary(s);
    const needed = text.indexOf(`${key} needs-human: The spec needs a decision`);
    expect(needed).toBeGreaterThan(-1);
    for (const [n, label] of labels.entries()) {
      const line = text.indexOf(`     ${label}: `);
      expect(line, label).toBeGreaterThan(needed);
      expect(text.slice(line).split('\n')[0]).toContain(links[n]);
    }
    expect(text.indexOf(`     reason: ${reason}`)).toBeGreaterThan(text.indexOf(links[1] ?? '?'));

    // orch status: the recorded session's waiting job, in JSON and in text.
    const status = runnerStatus(store);
    expect(status.waiting).toEqual([
      {
        ticketId: id,
        jobId,
        needed:
          'The spec needs a decision from a person: pick "Rewrite the spec" or "Drop the job".',
        choices: [
          {
            label: 'Rewrite the spec',
            effect: 'the job goes back to spec and carries on from there',
            link: links[0],
          },
          {
            label: 'Drop the job',
            effect: 'the job ends for good; its branch and worktree are kept',
            link: links[1],
          },
        ],
      },
    ]);
    const lines = formatStatus(status).split('\n');
    expect(lines[0]).toBe(
      `needs you   ${key}: The spec needs a decision from a person: pick "Rewrite the spec" or "Drop the job".`,
    );
    for (const [n, label] of labels.entries()) {
      expect(lines[n + 1]).toContain(`${label}: `);
      expect(lines[n + 1]).toContain(links[n]);
    }

    // Once a person answered, nothing is listed as waiting any more.
    const { token } = claimJob(store, jobId, { session: 'human' });
    transitionJob(store, jobId, 'resume', { token, to: 'spec' });
    expect(runnerStatus(store).waiting).toEqual([]);
    expect(formatStatus(runnerStatus(store))).not.toContain('needs you');
  });
});
