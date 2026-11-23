/**
 * A driven fast job (decision 2026-11-23-fast-mode): build -> pr -> ci -> completed with the same
 * worktree, lease, verification, push, PR, CI reconciliation, ticket claim, and events as a full
 * job; the fast build gate; and escalation. Delivery under `ci` authority and CI repairs are in
 * fast-delivery.test.ts, base integration in fast-integration.test.ts.
 */
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/core/errors.ts';
import { planJob, resumeFactoryJob } from '../src/ops/factory.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { jobUsage } from '../src/ops/usage.ts';
import { listArtifacts } from '../src/storage/artifacts.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  add,
  CHECK_JS,
  deliverPr,
  go,
  head,
  passSpec,
  POLICY,
  start,
  startFast,
  verify,
} from './drive.ts';
import { commitFile, fixture, gitIn } from './helpers.ts';
import { checks, clone, job, reconcile, run, store } from './ci-fixture.ts';

describe('a fast job', () => {
  it('goes build -> pr -> ci -> completed through the full workflow gates, with one agent', () => {
    const t = addTicket(store, { title: 'Fix the typo', repo: clone }).id;
    const c = startFast(store, clone, t);
    expect(job(c)).toMatchObject({ mode: 'fast', stage: 'build', status: 'pending', ticketId: t });
    expect(showTicket(store, t).ticket).toMatchObject({ status: 'in-progress', activeJob: c.id });
    const created = listEvents(store.db, c.id, 1000).find((e) => e.type === 'job.created');
    expect(created?.payload).toMatchObject({ mode: 'fast' });

    // One agent, and the build needs a passing verification run for HEAD.
    const plan = planJob(store, c.id);
    expect(plan.agents.map((a) => a.agent)).toEqual(['factory-fast-builder']);
    go(store, c, 'start');
    commitFile(c.wt, 'docs/typo.md', 'fixed\n');
    add(store, c, 'build.md');
    expect(() => go(store, c, 'complete')).toThrow(/No valid verification run for HEAD/);
    expect(verify(store, c).status).toBe('passed');
    expect(go(store, c, 'complete')).toMatchObject({ stage: 'pr', status: 'pending', round: 0 });

    go(store, c, 'start');
    const pr = planJob(store, c.id);
    expect(pr.agents).toEqual([]);
    expect(pr.reason).toContain('Fast job: pr.md is concise');
    deliverPr(store, c);
    expect(job(c).stage).toBe('ci');
    go(store, c, 'start');
    expect(planJob(store, c.id).agents).toEqual([]);
    checks(head(c.wt), [run('test', 'success')]);
    reconcile(c);
    expect(job(c)).toMatchObject({ stage: 'completed', status: 'completed', ciHead: head(c.wt) });

    // No stage a fast job skips was ever entered, and no approval artifact exists.
    const started = listEvents(store.db, c.id, 1000)
      .filter((e) => e.type === 'stage.started')
      .map((e) => e.payload['stage']);
    expect(new Set(started)).toEqual(new Set(['build', 'pr', 'ci']));
    expect(listArtifacts(store.db, c.id).map((a) => a.path)).not.toContain('decision.md');

    // The usage report measures the fast route.
    const u = jobUsage(store, c.id);
    expect(u.mode).toBe('fast');
    expect(u.stages.map((v) => v.stage)).toEqual(['build', 'pr', 'ci']);
    expect(u.stages.every((v) => v.durationMs !== null)).toBe(true);
    expect(u.wallMs).toBeGreaterThanOrEqual(0);
    // The ticket closes only through a verified merge (mergeJob), not here.
    expect(showTicket(store, t).ticket.status).toBe('in-progress');
  });

  it('a build that changes what the checks run or see is refused with escalate; a full build is not', () => {
    commitFile(clone, 'tests/a.test.ts', "it('a', () => {});\nit('b', () => {});\n");
    gitIn(clone, 'push', '-q', 'origin', 'main');
    const c = startFast(store, clone);
    go(store, c, 'start');
    const risky: [string, string, RegExp][] = [
      ['package.json', '{ "name": "x" }\n', /package\.json \(deps/],
      ['.github/workflows/ci.yml', 'on: push\n', /ci\.yml \(ci/],
      ['vitest.config.ts', 'export default {};\n', /vitest\.config\.ts \(test-config/],
      ['check.js', `${CHECK_JS}// edited\n`, /check\.js \(policy/],
      ['tests/a.test.ts', "it.skip('a', () => {});\nit('b', () => {});\n", /disabled test/],
      ['tests/a.test.ts', "it('a', () => {});\n", /test\(s\) removed/],
      ['factory.json', `${JSON.stringify(POLICY)}\n`, /factory\.json \(policy/],
    ];
    let replace = false;
    for (const [file, body, why] of risky) {
      commitFile(c.wt, file, body, `risky ${file}`);
      expect(verify(store, c).status).toBe('passed');
      add(store, c, 'build.md', fixture('build.md'), replace);
      replace = true;
      expect(() => go(store, c, 'complete')).toThrow(ValidationError);
      expect(() => go(store, c, 'complete')).toThrow(why);
      expect(() => go(store, c, 'complete')).toThrow(/Escalate/);
      expect(job(c).stage).toBe('build');
      gitIn(c.wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'revert', '--no-edit', 'HEAD');
    }

    // The same kind of diff in a full job is the reviewers' to judge, not this rule's.
    const full = start(store, clone, 'Bump a dependency');
    passSpec(store, full);
    go(store, full, 'start');
    commitFile(full.wt, 'package.json', '{ "name": "x" }\n');
    verify(store, full);
    add(store, full, 'build.md');
    expect(go(store, full, 'complete').stage).toBe('simplify');
  });

  it('escalating keeps the worktree, branch, and commits; resume is limited to fast stages', () => {
    const c = startFast(store, clone);
    go(store, c, 'start');
    const sha = commitFile(c.wt, 'src/half.ts', '// half done\n');
    go(store, c, 'escalate', 'broader than the ticket');
    const branch = job(c).branch ?? '';
    expect(job(c)).toMatchObject({ stage: 'needs-human', returnStage: 'build', mode: 'fast' });
    const blocked = listEvents(store.db, c.id, 1000).find((e) => e.type === 'job.blocked');
    expect(blocked?.payload).toMatchObject({ from: 'build', reason: 'broader than the ticket' });
    expect(existsSync(c.wt)).toBe(true);
    expect(head(c.wt)).toBe(sha);
    expect(gitIn(clone, 'branch', '--list', branch)).toContain(branch);

    for (const to of ['spec', 'simplify', 'review', 'approve'] as const) {
      expect(() => resumeFactoryJob(store, c.id, { session: 'human', to, force: true })).toThrow(
        /cancel the job and `orch ticket reopen` it to run the full workflow/,
      );
    }
    expect(job(c)).toMatchObject({ stage: 'needs-human', mode: 'fast' });
    const r = resumeFactoryJob(store, c.id, { session: 'human', to: 'build', force: true });
    expect(r.job).toMatchObject({ stage: 'build', status: 'pending', mode: 'fast' });
    expect(head(c.wt)).toBe(sha);
  });
});
