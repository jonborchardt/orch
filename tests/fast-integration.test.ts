/**
 * Base integration of a fast job (decision 2026-11-23-fast-mode): the integrations row records
 * build.md's HEAD as the approved head, a clean merge re-verifies and delivers, and an edited
 * merge is refused and reworked to build, never to review.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pushBranch } from '../src/ops/github.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { getJob } from '../src/storage/jobs.ts';
import { fastBuild, go, startFast, verify } from './drive.ts';
import { gitIn } from './helpers.ts';
import { advanceBase, clone, deliver, store } from './integration-fixture.ts';

describe('fast job base integration', () => {
  it("a clean merge records build.md's HEAD, needs re-verification, then delivers", () => {
    const c = startFast(store, clone);
    const built = fastBuild(store, c);
    go(store, c, 'start');
    advanceBase('docs/notes.md', 'upstream\n');
    const r = integrateBase(store, c.id, { token: c.token });
    expect(r.integration).toMatchObject({ status: 'merged', fromHead: built, decisionHead: built });
    expect(getJob(store.db, c.id).stage).toBe('pr');
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/No valid verification run/);
    expect(verify(store, c).status).toBe('passed');
    deliver(c);
  });

  it('an edited merge is refused delivery and reworks to build', () => {
    const c = startFast(store, clone);
    fastBuild(store, c);
    go(store, c, 'start');
    advanceBase('docs/notes.md', 'upstream\n');
    gitIn(c.wt, 'merge', '--no-commit', '--no-ff', 'origin/main');
    writeFileSync(join(c.wt, 'src', 'app.ts'), 'export const app = 99; // smuggled\n');
    gitIn(c.wt, 'add', '-A');
    gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'merge with edit');
    verify(store, c);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/match neither parent/);
    expect(go(store, c, 'rework', 'edited merge')).toMatchObject({ stage: 'build', mode: 'fast' });
  });
});
