/**
 * Todo 0107: a spec the challenger rejected three times (ticket 0176) is continued by a human
 * editing spec.md and resuming to spec (`--release` leaves the job free for `orch do`); the next
 * plan registers the edit and re-challenges it instead of escalating again.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnershipError } from '../src/core/errors.ts';
import { resumeFactoryJob, startJob } from '../src/ops/factory.ts';
import { addArtifact } from '../src/ops/gates.ts';
import { RUNNER_SESSION } from '../src/ops/run.ts';
import { addTicket } from '../src/ops/tickets.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import { fixture, json, orch, writeArtifact } from './helpers.ts';
import { store, clone, SESSION, type Ctx, start, next, go, runStage } from './factory-fixture.ts';

const HUMAN = 'terminal-human';
const reg = (c: Ctx, rel: string, body = fixture(rel), replace = false) => {
  writeArtifact(c.dir, rel, body);
  addArtifact(store, c.id, rel, { token: c.token, replace });
};
const add = (c: Ctx, rel: string, replace = false) =>
  `orch job artifact add ${c.id} ${rel}${replace ? ' --replace' : ''} --token <token>`;
const THRICE = 'spec challenger requested changes three times; see spec-review-3.md';
const escalate = (c: Ctx) =>
  `orch job transition ${c.id} escalate --reason "${THRICE}" --token <token>`;

/** A job for a ticket, so the steps end in `orch do <key>`. */
function ticketJob(): Ctx & { key: string } {
  const t = addTicket(store, { title: 'Edit the spec' }, clone);
  const r = startJob(store, { ticket: t.id, session: SESSION, cwd: clone });
  const wt = r.job.worktreePath ?? '';
  return { id: r.job.id, token: r.token, dir: r.plan.artifactDir, wt, plan: r.plan, key: t.key };
}

/** spec, CHANGES, revise, CHANGES, revise, CHANGES: the plan now says escalate. */
function thriceRejected(c: Ctx) {
  go(c, 'start');
  reg(c, 'spec.md');
  reg(c, 'spec-review-1.md', fixture('spec-review-1.md', 'CHANGES'));
  reg(c, 'spec.md', fixture('spec.md') + '\nrevised\n', true);
  reg(c, 'spec-review-2.md', fixture('spec-review-2.md', 'CHANGES'));
  expect(next(c.id).commands.join('\n')).not.toContain('escalate');
  reg(c, 'spec.md', fixture('spec.md') + '\nrevised again\n', true);
  reg(c, 'spec-review-3.md', fixture('spec-review-3.md', 'CHANGES'));
  const plan = next(c.id);
  expect(plan.agents).toEqual([]);
  expect(plan.commands).toEqual([escalate(c)]);
}

/** Escalate and leave the job, as the controller does with a job waiting in needs-human. */
function escalateFree(c: Ctx, reason: string) {
  go(c, 'escalate', reason);
  releaseJob(store, c.id, { token: c.token });
}

/** Escalate, then a human resumes to spec from a terminal and leaves the job free. */
function escalateAndResume(c: Ctx) {
  escalateFree(c, THRICE);
  const r = resumeFactoryJob(store, c.id, { session: HUMAN, to: 'spec', release: true });
  expect([r.released, r.token, r.job.ownerSession]).toEqual([true, null, null]);
}

/** The next session claims the job the way the controller's child does. */
function claim(c: Ctx) {
  c.token = resumeFactoryJob(store, c.id, { session: SESSION }).token;
}

function expectSteps(reason: string, c: Ctx, key: string) {
  expect(reason).toContain(join(c.dir, 'spec.md'));
  expect(reason).toContain('Resume at spec');
  expect(reason).toContain(`orch factory resume ${c.id} --to spec --release`);
  expect(reason).toContain(`orch do ${key}`);
  expect(reason).not.toContain('orch job release');
}

describe('spec challenge slots', () => {
  it('CHANGES, CHANGES, PASS reaches build with no escalate in any plan', () => {
    const c = start();
    go(c, 'start');
    reg(c, 'spec.md');
    const plans = [];
    reg(c, 'spec-review-1.md', fixture('spec-review-1.md', 'CHANGES'));
    plans.push(next(c.id));
    reg(c, 'spec.md', fixture('spec.md') + '\nrevised\n', true);
    plans.push(next(c.id));
    reg(c, 'spec-review-2.md', fixture('spec-review-2.md', 'CHANGES'));
    plans.push(next(c.id));
    reg(c, 'spec.md', fixture('spec.md') + '\nrevised again\n', true);
    plans.push(next(c.id));
    expect(plans.map((p) => p.agents.map((a) => [a.agent, a.artifact]))).toEqual([
      [['factory-spec-writer', 'spec.md']],
      [['factory-spec-challenger', 'spec-review-2.md']],
      [['factory-spec-writer', 'spec.md']],
      [['factory-spec-challenger', 'spec-review-3.md']],
    ]);
    expect(plans.flatMap((p) => p.commands).join('\n')).not.toContain('escalate');
    reg(c, 'spec-review-3.md', fixture('spec-review-3.md', 'PASS'));
    expect(next(c.id).commands).toEqual([`orch job transition ${c.id} complete --token <token>`]);
    expect(go(c, 'complete').stage).toBe('build');
  });

  it('refuses spec-review-4.md after a third CHANGES', () => {
    const c = start();
    thriceRejected(c);
    writeArtifact(c.dir, 'spec-review-4.md', fixture('spec-review-4.md', 'PASS'));
    expect(() => addArtifact(store, c.id, 'spec-review-4.md', { token: c.token })).toThrow(
      /not a spec challenge slot/,
    );
  });
});

describe('spec escalation resumed by a human edit', () => {
  it('registers the edited spec.md after a human resume, re-challenges it, and completes', () => {
    const c = start();
    thriceRejected(c);
    escalateAndResume(c);
    writeArtifact(c.dir, 'spec.md', fixture('spec.md') + '\nhuman edit\n');
    claim(c);
    let plan = next(c.id);
    expect(plan.stage).toBe('spec');
    expect(plan.agents.map((a) => [a.agent, a.artifact])).toEqual([
      ['factory-spec-writer', 'spec.md'],
    ]);
    expect(plan.commands).toEqual([
      `orch job transition ${c.id} start --token <token>`,
      add(c, 'spec.md', true),
      `orch factory next ${c.id}`,
    ]);
    expect(plan.commands.join('\n')).not.toContain('escalate');

    go(c, 'start');
    addArtifact(store, c.id, 'spec.md', { token: c.token, replace: true });
    plan = next(c.id);
    expect(plan.agents.map((a) => [a.agent, a.artifact])).toEqual([
      ['factory-spec-challenger', 'spec-review-3.md'],
    ]);
    expect(plan.commands).toEqual([add(c, 'spec-review-3.md', true), `orch factory next ${c.id}`]);
    reg(c, 'spec-review-3.md', fixture('spec-review-3.md', 'PASS'), true);
    expect(go(c, 'complete').stage).toBe('build');
  });

  it('escalates again when the edit has no human resume after the latest challenge', () => {
    const c = start();
    thriceRejected(c);
    // The session edits spec.md itself: no human resume, so the plan still escalates.
    writeArtifact(c.dir, 'spec.md', fixture('spec.md') + '\nagent edit\n');
    expect(next(c.id).commands).toEqual([escalate(c)]);
  });

  it('escalates again when spec.md is unchanged after the human resume; texts name the steps', () => {
    const c = ticketJob();
    thriceRejected(c);
    expectSteps(next(c.id).reason, c, c.key);
    escalateFree(c, THRICE);
    const waiting = next(c.id);
    expect(waiting.step).toBe('needs-human');
    expectSteps(waiting.reason, c, c.key);

    const r = resumeFactoryJob(store, c.id, { session: HUMAN, to: 'spec', release: true });
    expect(r.released).toBe(true);
    claim(c);
    const plan = next(c.id);
    expect(plan.commands).toEqual([escalate(c)]);
    expectSteps(plan.reason, c, c.key);
  });

  it('a job that escalated after spec-review-2.md CHANGES still waits for a human', () => {
    const c = ticketJob();
    go(c, 'start');
    reg(c, 'spec.md');
    reg(c, 'spec-review-1.md', fixture('spec-review-1.md', 'CHANGES'));
    reg(c, 'spec.md', fixture('spec.md') + '\nrevised\n', true);
    reg(c, 'spec-review-2.md', fixture('spec-review-2.md', 'CHANGES'));
    // Escalated under the old two-slot bound.
    escalateFree(c, 'spec challenger requested changes twice; see spec-review-2.md');
    const waiting = next(c.id);
    expect(waiting.step).toBe('needs-human');
    expect(waiting.commands.join('\n')).not.toContain('artifact add');
    expectSteps(waiting.reason, c, c.key);
    const job = getJob(store.db, c.id);
    expect([job.stage, job.status]).toEqual(['needs-human', 'blocked']);
  });

  it('keeps the needs-human text for other stages; /factory when there is no ticket', () => {
    const c = start();
    thriceRejected(c);
    expect(next(c.id).reason).toContain(`3. run /factory ${c.id}`);
    const d = start('Other stage');
    runStage(d, 'spec.md');
    go(d, 'start');
    go(d, 'escalate', 'unclear request');
    expect(next(d.id).reason).toBe(
      'A human must decide. Report the blocking reason and stop. To continue after the decision: ' +
        `orch factory resume ${d.id} --to build, then run /factory ${d.id}`,
    );
  });
});

describe('orch factory resume --release', () => {
  it('leaves a needs-human job free for the controller after the decision', () => {
    const c = start();
    go(c, 'start');
    escalateFree(c, 'decide');
    const r = resumeFactoryJob(store, c.id, { session: HUMAN, to: 'spec', release: true });
    const job = getJob(store.db, c.id);
    expect([job.ownerSession, job.stage, job.status]).toEqual([null, 'spec', 'pending']);
    expect(r.job.ownerSession).toBeNull();
    expect(
      listEvents(store.db, c.id).some(
        (e) => e.type === 'job.resumed' && e.payload['to'] === 'spec',
      ),
    ).toBe(true);
    expect(claimJob(store, c.id, { session: RUNNER_SESSION }).token).toBeTruthy();
  });

  it('does not weaken ownership; without --release the session keeps the lease', () => {
    const c = start();
    go(c, 'start');
    const held = getJob(store.db, c.id);
    expect(() =>
      resumeFactoryJob(store, c.id, { session: HUMAN, to: 'spec', release: true }),
    ).toThrow(OwnershipError);
    const after = getJob(store.db, c.id);
    expect([after.ownerSession, after.ownerToken, after.leaseExpiresAt]).toEqual([
      held.ownerSession,
      held.ownerToken,
      held.leaseExpiresAt,
    ]);

    go(c, 'escalate', 'decide');
    const kept = resumeFactoryJob(store, c.id, { session: SESSION, to: 'spec' });
    expect(kept.released).toBe(false);
    expect(kept.token).toBe(getJob(store.db, c.id).ownerToken);
    expect(getJob(store.db, c.id).ownerSession).toBe(SESSION);
  });

  it('CLI: --release prints released and a null token; without --to it is a usage error', () => {
    const c = start();
    go(c, 'start');
    escalateFree(c, 'decide');
    const bad = orch(store.home, tmpdir(), ['factory', 'resume', c.id, '--release']);
    expect(bad.code).toBe(2);
    const r = orch(store.home, tmpdir(), [
      '--json',
      'factory',
      'resume',
      c.id,
      '--to',
      'spec',
      '--release',
      '--session',
      HUMAN,
    ]);
    expect(r.code).toBe(0);
    const out = json<{ released: boolean; token: string | null }>(r);
    expect([out.released, out.token]).toEqual([true, null]);
    expect(getJob(store.db, c.id).ownerSession).toBeNull();
  });

  it('CLI: --to releases by default; a live lease of another session still exits 4', () => {
    const c = start();
    go(c, 'start');
    const resume = () =>
      orch(store.home, tmpdir(), [
        '--json',
        'factory',
        'resume',
        c.id,
        '--to',
        'spec',
        '--session',
        HUMAN,
      ]);
    const held = getJob(store.db, c.id);
    expect(resume().code).toBe(4);
    const after = getJob(store.db, c.id);
    expect([after.ownerSession, after.ownerToken, after.leaseExpiresAt]).toEqual([
      held.ownerSession,
      held.ownerToken,
      held.leaseExpiresAt,
    ]);

    escalateFree(c, 'decide');
    const r = resume();
    expect(r.code).toBe(0);
    const out = json<{ released: boolean; token: string | null }>(r);
    expect([out.released, out.token]).toEqual([true, null]);
    expect(getJob(store.db, c.id).ownerSession).toBeNull();
    expect(claimJob(store, c.id, { session: RUNNER_SESSION }).token).toBeTruthy();
  });
});
