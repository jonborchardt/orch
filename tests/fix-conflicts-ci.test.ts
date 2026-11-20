/**
 * Base integration in the ci stage: a conflict, or any merge, sends the job back to build as
 * integration rework without spending a CI repair, from the dashboard's Fix merge conflicts and
 * from `orch worktree integrate` alike.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { dashboardAction } from '../src/ops/actions.ts';
import { configPath, planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import { listIntegrations } from '../src/storage/verification.ts';
import { type Ctx, start, toCi } from './drive.ts';
import { commitFile, gitIn, orch } from './helpers.ts';
import { clone, job, store } from './ci-fixture.ts';

function advanceBase(file: string, body: string): void {
  commitFile(clone, file, body, `base: ${file}`);
  gitIn(clone, 'push', '-q', 'origin', 'main');
}

/** A running ci job whose src/app.ts edit conflicts with the base's. */
function conflictingCi(): Ctx {
  const c = start(store, clone);
  commitFile(c.wt, 'src/app.ts', 'export const app = 1; // job\n');
  toCi(store, c);
  advanceBase('src/app.ts', 'export const app = 2; // base\n');
  return c;
}

const lastReworked = (c: Ctx) =>
  listEvents(store.db, c.id, 1000)
    .filter((e) => e.type === 'job.reworked')
    .at(-1)?.payload;

describe('ci stage: base integration reworks without spending a CI repair', () => {
  it('Fix merge conflicts at the repair limit records the conflict and returns to build', () => {
    writeFileSync(configPath(store), JSON.stringify({ maxCiRepairs: 0 }));
    const c = conflictingCi();
    expect(job(c)).toMatchObject({ stage: 'ci', ciRepairs: 0, maxCiRepairs: 0 });
    const shown = detail(store, c.id);
    expect(shown.actions).toContain('fix-conflicts');
    expect(shown.conflicts).toEqual({ files: ['src/app.ts'], github: false });
    const r = dashboardAction(store, c.id, { action: 'fix-conflicts', force: true });
    expect(listIntegrations(store.db, c.id).map((i) => [i.status, i.conflicts])).toEqual([
      ['conflict', ['src/app.ts']],
    ]);
    expect(job(c)).toMatchObject({
      stage: 'build',
      status: 'pending',
      ciRepairs: 0,
      ownerSession: null,
      ownerToken: null,
    });
    expect(lastReworked(c)).toMatchObject({ from: 'ci', integration: true, ciRepairs: 0 });
    expect(r.message).toContain('No CI repair was used');
    expect(r.resumeCommand).toBe(`orch factory resume ${c.id} --session <name>`);
    // The next session's build plan names base integration, not a CI repair.
    const reason = resumeFactoryJob(store, c.id, { session: 'next-builder' }).plan.reason;
    expect(reason).toContain('Base integration needs the builder');
    expect(reason).not.toContain('CI repair');
  });

  it('orch worktree integrate in ci reworks on a conflict instead of exiting 1', () => {
    const c = conflictingCi();
    const r = orch(store.home, tmpdir(), ['worktree', 'integrate', c.id, '--token', c.token]);
    expect(r.code, r.err).toBe(0);
    expect(job(c)).toMatchObject({ stage: 'build', status: 'pending', ciRepairs: 0 });
    expect(listIntegrations(store.db, c.id).map((i) => i.status)).toEqual(['conflict']);
  });

  it('a clean base merge in ci also returns to build: the new head needs approval and pr', () => {
    const c = start(store, clone);
    toCi(store, c);
    advanceBase('docs/notes.md', 'upstream\n');
    const r = integrateBase(store, c.id, { token: c.token });
    expect([r.integration.status, r.next]).toEqual(['merged', 'rework']);
    expect(job(c)).toMatchObject({ stage: 'build', status: 'pending', ciRepairs: 0 });
    const reason = String(lastReworked(c)?.['reason']);
    expect(reason).toContain('approval');
    expect(reason).toContain('pr stage');
    expect(planJob(store, c.id).reason).toContain('Base integration needs the builder');
  });
});
