/**
 * Recovery passes never claim agent-stage jobs, and escalate a ci job after the retry budget for
 * its head is spent. Split from recover.test.ts because each scenario drives its own job.
 */
import { describe, expect, it } from 'vitest';

import { RECOVERY_MAX_FAILURES } from '../src/core/recovery.ts';
import { recoverPass } from '../src/ops/recover.ts';
import { listEvents } from '../src/storage/events.ts';
import { releaseJob } from '../src/storage/jobs.ts';
import { add, type Ctx, go, start, toCi } from './drive.ts';
import { clone, job, shim, store } from './ci-fixture.ts';

const events = (c: Ctx) => listEvents(store.db, c.id, 1000);
const entry = (c: Ctx, pass: ReturnType<typeof recoverPass>) =>
  pass.jobs.find((j) => j.jobId === c.id);

describe('recovery pass: what it leaves alone', () => {
  it('reports unowned agent-stage jobs as needs-session and never claims them', () => {
    const spec = start(store, clone, 'Spec job');
    releaseJob(store, spec.id, { token: spec.token });
    const build = start(store, clone, 'Build job');
    go(store, build, 'start');
    add(store, build, 'spec.md');
    go(store, build, 'complete');
    releaseJob(store, build.id, { token: build.token });

    const before = [job(spec), job(build)];
    const pass = recoverPass(store);
    expect(pass.online).toBe(true);
    for (const [c, stage] of [
      [spec, 'spec'],
      [build, 'build'],
    ] as const) {
      const e = entry(c, pass);
      expect(e).toMatchObject({ class: 'needs-session', action: 'none', stage });
      expect(e?.reason).toContain('needs an agent session');
      expect(e?.resume).toContain(`/factory ${c.id}`);
    }
    expect([job(spec), job(build)]).toEqual(before);
    for (const c of [spec, build]) {
      expect(events(c).some((e) => e.type.startsWith('recovery.'))).toBe(false);
    }
  });

  it('escalates after five failed attempts for the same head, then leaves the job alone', () => {
    const c = start(store, clone);
    toCi(store, c);
    releaseJob(store, c.id, { token: c.token });
    // The probe answers but every PR read fails: each attempt fails inside the episode.
    shim.write({ fail: 'pr view' });
    for (let i = 1; i < RECOVERY_MAX_FAILURES; i++) {
      expect(entry(c, recoverPass(store))).toMatchObject({
        class: 'recoverable',
        action: 'failed',
      });
      // A failed attempt leaves the job unowned and running, pickable by the next pass.
      expect(job(c)).toMatchObject({ stage: 'ci', status: 'running', ownerSession: null });
    }
    expect(entry(c, recoverPass(store))).toMatchObject({ action: 'escalated' });
    expect(job(c)).toMatchObject({ stage: 'needs-human', status: 'blocked', ownerSession: null });
    const blocked = events(c).find((e) => e.type === 'job.blocked');
    expect(String(blocked?.payload['reason'])).toMatch(/^recovery retries exhausted: /);
    expect(events(c).filter((e) => e.type === 'recovery.failed')).toHaveLength(
      RECOVERY_MAX_FAILURES,
    );

    const after = job(c);
    expect(entry(c, recoverPass(store))).toMatchObject({ class: 'human', action: 'none' });
    expect(job(c).revision).toBe(after.revision);
  });
});
