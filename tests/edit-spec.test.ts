/**
 * Ticket 0160: a spec escalation's spec.md is edited from the dashboard (`edit-spec`), registered
 * through `addArtifact` with `replace`, and still re-challenged before the job leaves spec.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.ts';
import { allowedActions, currentChoices, dashboardAction } from '../src/ops/actions.ts';
import { resumeFactoryJob } from '../src/ops/factory.ts';
import { addArtifact } from '../src/ops/gates.ts';
import { findArtifact } from '../src/storage/artifacts.ts';
import { listEvents } from '../src/storage/events.ts';
import { claimJob, getJob, releaseJob } from '../src/storage/jobs.ts';
import { parseAction } from '../src/server/api.ts';
import { fixture, orch, writeArtifact } from './helpers.ts';
import { store, SESSION, type Ctx, start, next, go, runStage } from './factory-fixture.ts';

const reg = (c: Ctx, rel: string, body = fixture(rel), replace = false) => {
  writeArtifact(c.dir, rel, body);
  addArtifact(store, c.id, rel, { token: c.token, replace });
};

/** spec rejected three times, escalated, and left free: the state the dashboard edits in. */
function specEscalation(): Ctx {
  const c = start();
  go(c, 'start');
  reg(c, 'spec.md');
  reg(c, 'spec-review-1.md', fixture('spec-review-1.md', 'CHANGES'));
  reg(c, 'spec.md', fixture('spec.md') + '\nrevised\n', true);
  reg(c, 'spec-review-2.md', fixture('spec-review-2.md', 'CHANGES'));
  reg(c, 'spec.md', fixture('spec.md') + '\nrevised again\n', true);
  reg(c, 'spec-review-3.md', fixture('spec-review-3.md', 'CHANGES'));
  go(c, 'escalate', 'spec challenger requested changes three times; see spec-review-3.md');
  releaseJob(store, c.id, { token: c.token });
  return c;
}

const edited = fixture('spec.md') + '\nedited on the job page\n';
const disk = (c: Ctx) => readFileSync(join(c.dir, 'spec.md'));

describe('edit-spec', () => {
  it('is offered only for an unfinished needs-human job returning to spec', () => {
    const base = {
      stage: 'needs-human' as const,
      status: 'blocked' as const,
      round: 0,
      returnStage: 'spec' as const,
      prUrl: null,
      ciHead: null,
      ciStatus: null,
      prState: null,
      archivedAt: null,
      worktreePath: null,
      supersededBy: null,
    };
    expect(allowedActions(base, false)).toContain('edit-spec');
    for (const returnStage of ['build', 'ci', 'review'] as const) {
      expect(allowedActions({ ...base, returnStage }, false)).not.toContain('edit-spec');
    }
    for (const stage of ['spec', 'build', 'review'] as const) {
      expect(allowedActions({ ...base, stage, status: 'running' }, false)).not.toContain(
        'edit-spec',
      );
    }
    expect(allowedActions({ ...base, status: 'cancelled' }, false)).not.toContain('edit-spec');
  });

  it('parseAction takes content only with edit-spec, and requires it there as a string', () => {
    expect(parseAction({ action: 'edit-spec', content: 'x' })).toMatchObject({ content: 'x' });
    expect(() => parseAction({ action: 'edit-spec' })).toThrow(ValidationError);
    expect(() => parseAction({ action: 'edit-spec', content: 3 })).toThrow(ValidationError);
    expect(() => parseAction({ action: 'cancel', content: 'x' })).toThrow(ValidationError);
  });

  it('replaces spec.md, logs the replacement, and leaves the job waiting', () => {
    const c = specEscalation();
    const previous = findArtifact(store.db, c.id, 'spec.md')?.sha256;
    const r = dashboardAction(store, c.id, { action: 'edit-spec', content: edited });
    expect(r.message).toContain('spec.md replaced');
    expect(disk(c).toString()).toBe(edited);
    const row = findArtifact(store.db, c.id, 'spec.md');
    expect(row?.sha256).not.toBe(previous);
    expect(row?.stage).toBe('spec');
    const ev = listEvents(store.db, c.id)
      .filter((e) => e.type === 'artifact.replaced')
      .at(-1);
    expect(ev?.payload).toMatchObject({ path: 'spec.md', previousSha256: previous });
    const job = getJob(store.db, c.id);
    expect([job.stage, job.status, job.returnStage]).toEqual(['needs-human', 'blocked', 'spec']);

    const again = dashboardAction(store, c.id, { action: 'edit-spec', content: edited });
    expect(again.message).toContain('unchanged');
  });

  it('refuses invalid content and ineligible jobs without writing anything', () => {
    const c = specEscalation();
    const bytes = disk(c);
    const row = findArtifact(store.db, c.id, 'spec.md');
    const events = listEvents(store.db, c.id).length;
    const unchanged = () => {
      expect(disk(c).equals(bytes)).toBe(true);
      expect(findArtifact(store.db, c.id, 'spec.md')).toEqual(row);
      expect(listEvents(store.db, c.id).length).toBe(events);
    };
    const bad = fixture('spec.md').replace('## Acceptance criteria', '## Something else');
    expect(() => dashboardAction(store, c.id, { action: 'edit-spec', content: bad })).toThrow(
      /Acceptance criteria/,
    );
    unchanged();

    // A job in spec itself is not a spec escalation.
    const d = start('In spec');
    go(d, 'start');
    reg(d, 'spec.md');
    expect(() => dashboardAction(store, d.id, { action: 'edit-spec', content: edited })).toThrow(
      ValidationError,
    );
    expect(readFileSync(join(d.dir, 'spec.md'), 'utf8')).toBe(fixture('spec.md'));

    // needs-human from build.
    const b = start('From build');
    runStage(b, 'spec.md');
    go(b, 'start');
    go(b, 'escalate', 'unclear request');
    expect(() => dashboardAction(store, b.id, { action: 'edit-spec', content: edited })).toThrow(
      /Cannot edit spec.md/,
    );
  });

  it('the edit is re-challenged after the resume-to-spec answer; build stays gated', () => {
    const c = specEscalation();
    dashboardAction(store, c.id, { action: 'edit-spec', content: edited });
    expect(() => dashboardAction(store, c.id, { action: 'approve', to: 'build' })).toThrow(
      /challeng/i,
    );
    const choices = currentChoices(store, getJob(store.db, c.id)) ?? [];
    const toSpec = choices.findIndex((ch) => ch.to === 'spec');
    expect(toSpec).toBeGreaterThanOrEqual(0);
    dashboardAction(store, c.id, { action: 'answer', choice: toSpec });
    expect(getJob(store.db, c.id).stage).toBe('spec');

    c.token = resumeFactoryJob(store, c.id, { session: SESSION }).token;
    go(c, 'start');
    const plan = next(c.id);
    expect(plan.agents.map((a) => a.agent)).toEqual(['factory-spec-challenger']);
    expect(plan.commands.join('\n')).not.toContain('escalate');
    expect(() => go(c, 'complete')).toThrow(/Cannot complete/);
  });

  it('CLI: artifact add --replace takes spec.md in a spec escalation and nothing else', () => {
    const c = specEscalation();
    const token = claimJob(store, c.id, { session: SESSION }).token;
    writeArtifact(c.dir, 'spec.md', edited);
    const add = (rel: string) =>
      orch(store.home, tmpdir(), [
        'job',
        'artifact',
        'add',
        c.id,
        rel,
        '--replace',
        '--token',
        token,
      ]);
    expect(add('spec.md').code).toBe(0);
    expect(getJob(store.db, c.id).stage).toBe('needs-human');
    writeArtifact(c.dir, 'spec-review-3.md', fixture('spec-review-3.md', 'PASS'));
    expect(add('spec-review-3.md').code).toBe(1);
  });
});
