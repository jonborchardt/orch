/**
 * The dashboard's Fix merge conflicts action: a read-only conflict probe, then integrateBase in a
 * short dashboard episode that sends an approve- or pr-stage job back to build.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.ts';
import { mergeConflicts } from '../src/git/worktree.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { baseConflicts } from '../src/ops/worktree.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import { listIntegrations } from '../src/storage/verification.ts';
import { type Ctx, go, passRound, passSpec, start, toPr, toReview } from './drive.ts';
import { commitFile, gitIn } from './helpers.ts';
import { store, clone, advanceBase } from './integration-fixture.ts';

/** HEAD, index, status, and refs: everything the probe must leave alone. */
const snapshot = (wt: string) => [
  gitIn(wt, 'rev-parse', 'HEAD'),
  gitIn(wt, 'ls-files', '-s'),
  gitIn(wt, 'status', '--porcelain'),
  gitIn(wt, 'for-each-ref'),
];

/** A job in approve, running, whose src/app.ts edit conflicts with the base's. */
function conflictingApprove(): Ctx {
  const c = start(store, clone);
  toReview(store, c, 'src/app.ts');
  passRound(store, c);
  go(store, c, 'start');
  advanceBase('src/app.ts', 'export const app = 2; // base\n');
  return c;
}

const resume = (id: string) => `orch factory resume ${id} --session <name>`;

describe('fix-conflicts', () => {
  it('the probe names conflicting files and returns [] for a clean merge, touching nothing', () => {
    const c = start(store, clone);
    commitFile(c.wt, 'src/app.ts', 'export const app = 1; // job\n');
    advanceBase('docs/notes.md', 'upstream\n');
    let before = snapshot(c.wt);
    expect(mergeConflicts(c.wt, 'origin/main')).toEqual([]);
    expect(snapshot(c.wt)).toEqual(before);
    advanceBase('src/app.ts', 'export const app = 2; // base\n');
    before = snapshot(c.wt);
    expect(mergeConflicts(c.wt, 'origin/main')).toEqual(['src/app.ts']);
    expect(snapshot(c.wt)).toEqual(before);
  });

  it('in approve: records the conflict, reworks to build, releases, and names the resume', () => {
    const c = conflictingApprove();
    expect(baseConflicts(store, getJob(store.db, c.id))).toEqual({
      files: ['src/app.ts'],
      github: false,
    });
    // A live session lease is refused unless the takeover is forced.
    expect(() => dashboardAction(store, c.id, { action: 'fix-conflicts' })).toThrow(/live lease/);
    expect(listIntegrations(store.db, c.id)).toEqual([]);
    const r = dashboardAction(store, c.id, { action: 'fix-conflicts', force: true });
    expect(listIntegrations(store.db, c.id).map((i) => [i.status, i.conflicts])).toEqual([
      ['conflict', ['src/app.ts']],
    ]);
    const job = getJob(store.db, c.id);
    expect([job.stage, job.status, job.ownerSession, job.ownerToken]).toEqual([
      'build',
      'pending',
      null,
      null,
    ]);
    const reworked = listEvents(store.db, c.id, 1000).filter((e) => e.type === 'job.reworked');
    expect(JSON.stringify(reworked.at(-1))).toContain('conflicts in src/app.ts');
    expect(r.message).toContain('src/app.ts');
    expect(r.message).toContain('returned to build');
    expect(r.resumeCommand).toBe(resume(c.id));
  });

  it('in pr: the same', () => {
    const c = start(store, clone);
    commitFile(c.wt, 'src/app.ts', 'export const app = 1; // job\n');
    toPr(store, c);
    advanceBase('src/app.ts', 'export const app = 2; // base\n');
    const r = dashboardAction(store, c.id, { action: 'fix-conflicts', force: true });
    expect(listIntegrations(store.db, c.id).map((i) => i.status)).toEqual(['conflict']);
    const job = getJob(store.db, c.id);
    expect([job.stage, job.status, job.ownerSession]).toEqual(['build', 'pending', null]);
    expect(r.resumeCommand).toBe(resume(c.id));
  });

  it('refuses without conflicts, in build or needs-human, and when cancelled, changing nothing', () => {
    const refused = (c: Ctx) => {
      const before = getJob(store.db, c.id);
      expect(() => dashboardAction(store, c.id, { action: 'fix-conflicts', force: true })).toThrow(
        ValidationError,
      );
      expect(getJob(store.db, c.id)).toEqual(before);
      expect(listIntegrations(store.db, c.id)).toEqual([]);
    };
    // approve, behind, but the base change does not overlap.
    const clean = start(store, clone, 'Clean');
    toReview(store, clean, 'src/clean.ts');
    passRound(store, clean);
    advanceBase('docs/notes.md', 'upstream\n');
    expect(baseConflicts(store, getJob(store.db, clean.id))).toBeNull();
    refused(clean);
    // build, with a real conflict.
    const build = start(store, clone, 'Build');
    passSpec(store, build);
    commitFile(build.wt, 'src/app.ts', 'export const app = 1; // job\n');
    advanceBase('src/app.ts', 'export const app = 2; // base\n');
    expect(baseConflicts(store, getJob(store.db, build.id))).toBeNull();
    refused(build);
    // needs-human (here escalated from build), with the same conflict.
    go(store, build, 'start');
    go(store, build, 'escalate', 'stuck');
    expect(getJob(store.db, build.id).stage).toBe('needs-human');
    refused(build);
    // finished.
    const done = start(store, clone, 'Done');
    dashboardAction(store, done.id, { action: 'cancel', force: true });
    refused(done);
  });
});
