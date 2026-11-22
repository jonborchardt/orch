/**
 * Scope gap at approval (todo 0073): DECISION: REWORK-BUILD / REWORK-SPEC sends the job back on
 * its own, once; the plan tells each stage what to do; a second scope gap goes to a human.
 */
import { describe, expect, it } from 'vitest';
import { SCOPE_GAP_REASON } from '../src/core/workflow.ts';
import { addArtifact } from '../src/ops/gates.ts';
import { listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import { findArtifact } from '../src/storage/artifacts.ts';
import { commitFile, fixture, writeArtifact } from './helpers.ts';
import { store, type Ctx, start, next, go, runStage, reviewRound } from './factory-fixture.ts';

function toApprove(c: Ctx, file = 'src/export.ts') {
  if (getJob(store.db, c.id).stage === 'spec') runStage(c, 'spec.md');
  commitFile(c.wt, file, `// ${file}\n`);
  runStage(c, 'build.md', fixture('build.md'), getJob(store.db, c.id).round > 0);
  reviewRound(c, {});
  expect(next(c.id).stage).toBe('approve');
}

function decide(c: Ctx, marker: string, replace = false) {
  if (getJob(store.db, c.id).status === 'pending') go(c, 'start');
  writeArtifact(c.dir, 'decision.md', fixture('decision.md', marker));
  addArtifact(store, c.id, 'decision.md', { token: c.token, replace });
}

const reg = (c: Ctx, rel: string, body = fixture(rel), replace = false) => {
  writeArtifact(c.dir, rel, body);
  addArtifact(store, c.id, rel, { token: c.token, replace });
};

describe('scope-gap rework at approval', () => {
  it('REWORK-SPEC: spec is revised and re-challenged before build; the build plan names the gap', () => {
    const c = start();
    toApprove(c);
    const approve = next(c.id).commands.join('\n');
    expect(approve).toContain(`orch job transition ${c.id} rework --reason`);
    expect(approve).toMatch(/REWORK-BUILD.*REWORK-SPEC/);

    decide(c, 'REWORK-SPEC');
    const specHash = findArtifact(store.db, c.id, 'spec.md')?.sha256;
    expect(findArtifact(store.db, c.id, 'decision.md')?.specSha256).toBe(specHash);
    expect(() => go(c, 'complete')).toThrow(/REWORK-SPEC; use rework/);
    const back = go(c, 'rework', 'two requested cases were cut');
    expect([back.stage, back.status, back.scopeReworks]).toEqual(['spec', 'pending', 1]);

    // The spec writer revises spec.md; completing is not planned and is refused.
    let plan = next(c.id);
    expect(plan.agents.map((a) => [a.agent, a.artifact])).toEqual([
      ['factory-spec-writer', 'spec.md'],
    ]);
    expect(plan.reason).toMatch(/scope gap/i);
    expect(plan.commands).toContain(
      `orch job artifact add ${c.id} spec.md --replace --token <token>`,
    );
    expect(plan.commands.join(' ')).not.toContain(' complete');
    go(c, 'start');
    expect(() => go(c, 'complete')).toThrow(/REWORK-SPEC for this spec\.md/);

    // Revised: the challenge gate applies again, then spec completes to build.
    reg(c, 'spec.md', fixture('spec.md') + '\n- [ ] the two cut cases\n', true);
    plan = next(c.id);
    expect(plan.agents.map((a) => a.agent)).toEqual(['factory-spec-challenger']);
    expect(() => go(c, 'complete')).toThrow(/passed an earlier spec\.md/);
    reg(c, 'spec-review-1.md', fixture('spec-review-1.md'), true);
    expect(go(c, 'complete').stage).toBe('build');

    plan = next(c.id);
    expect(plan.reason.startsWith('Scope gap at approval: two requested cases were cut')).toBe(
      true,
    );
    expect(plan.reason).not.toContain('consolidated.md');
    expect(plan.reason).not.toContain('Base integration');
  });

  it('REWORK-BUILD goes back to build once; the next scope gap escalates to a human', () => {
    const c = start();
    toApprove(c);
    decide(c, 'REWORK-BUILD');
    const back = go(c, 'rework', 'AC3 is not implemented');
    expect([back.stage, back.status, back.scopeReworks, back.maxRounds]).toEqual([
      'build',
      'pending',
      1,
      4,
    ]);
    const plan = next(c.id);
    expect(plan.reason.startsWith('Scope gap at approval: AC3 is not implemented')).toBe(true);
    expect(plan.reason).toContain('decision.md');
    expect(plan.reason).not.toContain('consolidated.md');
    expect(plan.reason).not.toContain('Rework round');
    expect(plan.reason).not.toContain('Base integration');

    toApprove(c, 'src/ac3.ts');
    decide(c, 'REWORK-BUILD', true);
    const blocked = go(c, 'rework', 'AC3 still missing');
    expect([blocked.stage, blocked.status, blocked.returnStage, blocked.scopeReworks]).toEqual([
      'needs-human',
      'blocked',
      'build',
      1,
    ]);
    const event = listEvents(store.db, c.id).findLast((e) => e.type === 'job.blocked');
    expect(event?.payload).toEqual({
      from: 'approve',
      reason: SCOPE_GAP_REASON,
      detail: 'AC3 still missing',
    });
    expect(next(c.id).blockedReason).toBe(SCOPE_GAP_REASON);
  });
});
