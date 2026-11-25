/**
 * The controller after a `base-moved` merge (decision 2026-11-24-merge-requires-current-base): the
 * job is back in pr on a merge commit, so `runTicket` runs the same job again, counts no re-land,
 * and merges at the new head. Uses tests/run-fixture.ts.
 */
import { describe, expect, it } from 'vitest';

import { getJob } from '../src/storage/jobs.ts';
import type { Job } from '../src/storage/schema.ts';
import { commitFile, gitIn } from './helpers.ts';
import {
  clone,
  eventsOf,
  finish,
  jobsOf,
  launcher,
  merges,
  one,
  SHA,
  shim,
  status,
  store,
  ticket,
} from './run-fixture.ts';

describe('a base that moved after CI passed', () => {
  it('runs the reopened job again and merges at the new head, with no re-land', async () => {
    const id = ticket('Export CSV');
    let h2 = '';
    // First session: completed at SHA while origin's main moves past it.
    const first = (job: Job) => {
      finish(job);
      commitFile(clone, 'docs/notes.md', 'upstream\n', 'base moves');
      gitIn(clone, 'push', '-q', 'origin', 'main');
      shim.write({ api: { [`repos/acme/alpha/compare/main...${SHA}`]: { behind_by: 1 } } });
    };
    // Second session: the reopened job is delivered and completed at the merge commit.
    const second = (job: Job) => {
      expect(job.stage).toBe('pr');
      h2 = gitIn(job.worktreePath ?? '', 'rev-parse', 'HEAD');
      finish(job, {}, h2);
    };
    const l = launcher(first, second);

    const s = await one(l, id);

    const jobId = jobsOf(id)[0]?.id ?? '';
    expect(jobsOf(id)).toHaveLength(1);
    expect(l.calls.map((c) => c.jobId)).toEqual([jobId, jobId]);
    expect(s.tickets[0]).toMatchObject({ outcome: 'done', jobId, relands: 0 });
    expect(eventsOf(jobId, 'job.reopened')).toHaveLength(1);
    expect(getJob(store.db, jobId).ciHead).toBe(h2);
    expect(merges()).toHaveLength(1);
    expect(merges()[0]).toContain(h2);
    expect(status(id)).toBe('done');
  });
});
