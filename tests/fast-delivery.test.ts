/**
 * Fast-job delivery (decision 2026-11-23-fast-mode): build.md's HEAD binds push, PR creation, and
 * completion under `ci` authority too (a fast job has no pre-review pass), and failing CI reworks
 * to build within the repair budget, then escalates.
 */
import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MAX_CI_REPAIRS_REASON } from '../src/core/workflow.ts';
import { configPath } from '../src/ops/factory.ts';
import { ensureDraftPr, pushBranch } from '../src/ops/github.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  add,
  deliverPr,
  fastBuild,
  go,
  head,
  prBody,
  startFast,
  useCiAuthority,
  verify,
} from './drive.ts';
import { commitFile, writeArtifact } from './helpers.ts';
import { checks, clone, job, reconcile, run, shim, store } from './ci-fixture.ts';

describe('fast delivery', () => {
  it('under ci authority completes on passing CI without review, and refuses unbuilt commits', () => {
    useCiAuthority(clone);
    const c = startFast(store, clone);
    fastBuild(store, c);
    go(store, c, 'start');
    deliverPr(store, c);
    go(store, c, 'start');
    checks(head(c.wt), [run('test', 'success')]);
    reconcile(c);
    expect(job(c)).toMatchObject({ stage: 'completed', status: 'completed' });

    // A commit after build.md's HEAD is never delivered, under ci as under local.
    const late = startFast(store, clone);
    fastBuild(store, late, 'src/late-fix.ts');
    go(store, late, 'start');
    const body = writeArtifact(late.dir, 'pr.md', prBody(store, late));
    pushBranch(store, late.id, { token: late.token });
    ensureDraftPr(store, late.id, { token: late.token, bodyFile: body });
    commitFile(late.wt, 'src/unbuilt.ts', '// after build.md\n', 'unbuilt');
    verify(store, late);
    add(store, late, 'pr.md', prBody(store, late));
    expect(() => pushBranch(store, late.id, { token: late.token })).toThrow(/not approved/);
    expect(() => ensureDraftPr(store, late.id, { token: late.token, bodyFile: body })).toThrow(
      /not approved/,
    );
    expect(() => go(store, late, 'complete')).toThrow(/not approved/);
    expect(job(late).stage).toBe('pr');
  });

  it('failing CI reworks to build, the fast repair is delivered to the same PR and completes', () => {
    const c = startFast(store, clone);
    fastBuild(store, c);
    go(store, c, 'start');
    deliverPr(store, c);
    go(store, c, 'start');
    checks(head(c.wt), [run('test', 'failure')]);
    expect(reconcile(c)).toMatchObject({ outcome: 'failing', action: 'rework' });
    expect(job(c)).toMatchObject({ stage: 'build', ciRepairs: 1, mode: 'fast' });

    fastBuild(store, c, 'src/repair.ts', true);
    expect(job(c).stage).toBe('pr');
    go(store, c, 'start');
    deliverPr(store, c);
    go(store, c, 'start');
    checks(head(c.wt), [run('test', 'success')]);
    reconcile(c);
    expect(job(c).stage).toBe('completed');
    expect(shim.read().prs).toHaveLength(1);
    const visited = listEvents(store.db, c.id, 1000)
      .filter((e) => e.type === 'stage.started')
      .map((e) => e.payload['stage']);
    expect(visited).toEqual(['build', 'pr', 'ci', 'build', 'pr', 'ci']);
  });

  it('a spent CI repair budget sends the job to needs-human with the reason, mode unchanged', () => {
    writeFileSync(configPath(store), JSON.stringify({ maxCiRepairs: 0 }));
    const c = startFast(store, clone);
    fastBuild(store, c);
    go(store, c, 'start');
    deliverPr(store, c);
    go(store, c, 'start');
    checks(head(c.wt), [run('test', 'failure')]);
    reconcile(c);
    expect(job(c)).toMatchObject({ stage: 'needs-human', returnStage: 'build', mode: 'fast' });
    const blocked = listEvents(store.db, c.id, 1000).find((e) => e.type === 'job.blocked');
    expect(blocked?.payload['reason']).toBe(MAX_CI_REPAIRS_REASON);
  });
});
