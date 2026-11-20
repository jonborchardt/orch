import { describe, expect, it } from 'vitest';

import { formatFactoryList, formatPlan } from '../src/cli/output.ts';
import type { FactoryRow } from '../src/ops/dispatch.ts';
import type { Plan } from '../src/ops/factory.ts';

const NOW = new Date('2026-01-10T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function row(over: Partial<FactoryRow>): FactoryRow {
  return {
    id: 'job-00000001',
    title: 'A job',
    repo: 'github.com/o/r',
    repoPath: '/tmp/r',
    stage: 'build',
    status: 'running',
    round: 1,
    owner: { session: 's', live: true },
    needsHuman: false,
    blockedReason: null,
    worktreePath: null,
    branch: null,
    pr: { url: null, state: null, ciStatus: null },
    session: null,
    resume: null,
    updatedAt: ago(30_000),
    ...over,
  };
}

/** Cells of each line, split at the header's column start offsets. */
function columns(out: string): string[][] {
  const lines = out.split('\n');
  const header = lines[0] ?? '';
  const starts = [...header.matchAll(/\S+/g)].map((m) => m.index);
  return lines.map((l) => starts.map((s, i) => l.slice(s, starts[i + 1]).trim()));
}

describe('formatFactoryList', () => {
  it('prints (none) for no jobs', () => {
    expect(formatFactoryList([], NOW)).toBe('(none)');
  });

  it('derives ACTION, REPO, PR, and UPDATED from the row', () => {
    const rows = [
      row({
        id: 'job-human',
        stage: 'needs-human',
        status: 'blocked',
        needsHuman: true,
        updatedAt: ago(5 * 60_000),
      }),
      row({
        id: 'job-done',
        stage: 'completed',
        status: 'completed',
        owner: null,
        updatedAt: ago(2 * 3_600_000),
      }),
      row({ id: 'job-gone', status: 'cancelled', owner: null, updatedAt: ago(3 * 86_400_000) }),
      row({
        id: 'job-resu',
        status: 'interrupted',
        resume: 'orch factory resume job-resu',
        pr: { url: 'https://github.com/o/r/pull/42', state: 'draft', ciStatus: null },
      }),
      row({ id: 'job-wait' }),
    ];
    const out = formatFactoryList(rows, NOW);
    const t = columns(out);
    expect(t[0]).toEqual(['ID', 'REPO', 'STAGE', 'STATUS', 'ACTION', 'PR', 'UPDATED', 'TITLE']);
    expect(t.slice(1).map((c) => c[4])).toEqual(['human', 'none', 'none', 'resume', 'wait']);
    expect(t.slice(1).map((c) => c[1])).toEqual(['r', 'r', 'r', 'r', 'r']);
    expect(t.slice(1).map((c) => c[5])).toEqual(['-', '-', '-', '#42', '-']);
    expect(t.slice(1).map((c) => c[6])).toEqual([
      '5m ago',
      '2h ago',
      '3d ago',
      '30s ago',
      '30s ago',
    ]);
    expect(out.split('\n').every((l) => l === l.trimEnd())).toBe(true);
  });

  it('truncates long cells and keeps every column aligned', () => {
    const title = 'x'.repeat(80);
    const out = formatFactoryList(
      [row({ title, repo: 'github.com/o/a-very-long-repository-name' }), row({ id: 'job-2' })],
      NOW,
    );
    const lines = out.split('\n');
    const t = columns(out);
    expect(t[1]?.[7]).toHaveLength(50);
    expect(t[1]?.[7]?.endsWith('...')).toBe(true);
    expect(t[1]?.[1]).toHaveLength(16);
    expect(t[1]?.[1]?.endsWith('...')).toBe(true);
    // Every header column starts at the same offset in every row: the character before is a space.
    const starts = [...(lines[0] ?? '').matchAll(/\S+/g)].map((m) => m.index);
    for (const line of lines.slice(1)) {
      for (const s of starts.slice(1)) {
        expect(line.slice(s - 2, s)).toBe('  ');
        expect(line[s]).not.toBe(' ');
      }
    }
  });
});

function plan(over: Partial<Plan>): Plan {
  return {
    jobId: 'job-00000001',
    title: 'A job',
    stage: 'build',
    status: 'running',
    round: 1,
    maxRounds: 3,
    step: 'run-stage',
    reason: 'Build round 1.',
    owner: { session: 's', leaseExpiresAt: null, expired: false },
    repo: { identity: 'github.com/o/r', path: '/tmp/r', baseBranch: 'main' },
    artifactDir: '/tmp/a',
    worktree: { fingerprint: 'fp-0123456789abcdef', path: '/tmp/w' } as Plan['worktree'],
    checkoutDirty: ['stray-file.txt'],
    verification: null,
    sensitive: null,
    flake: null,
    integration: null,
    ui: false,
    agents: [],
    reviews: [],
    requiredArtifacts: ['build.md'],
    artifacts: [{ path: 'spec.md', stage: 'spec', ok: true }],
    commands: [],
    pr: { url: null, state: null, ciStatus: null },
    ci: {
      head: null,
      current: false,
      repairs: 0,
      maxRepairs: 2,
      polls: 7,
      sessionPolls: 5,
      reruns: 0,
      waitSeconds: 90,
      release: false,
      lastReason: null,
    },
    notices: [],
    noticeAck: null,
    ...over,
  };
}

describe('formatPlan', () => {
  it('answers where, what blocks, what next, and numbers the commands', () => {
    const out = formatPlan(
      plan({
        agents: [
          { role: 'builder', agent: 'factory-builder', model: 'opus', artifact: 'build.md' },
        ],
        commands: ['orch job show job-00000001', 'orch verify job-00000001 --token <token>'],
        pr: { url: 'https://github.com/o/r/pull/42', state: 'open', ciStatus: 'pending' },
      }),
    );
    expect(out).toContain('Job:     job-00000001');
    expect(out).toContain('Repo:    r');
    expect(out).toContain('Stage:   build (round 1 of 3)');
    expect(out).toContain('PR:      #42 (CI pending)');
    expect(out).toContain('Next:    Run the stage');
    expect(out).toContain('  builder  factory-builder  (opus)  -> build.md');
    const lines = out.split('\n');
    const at = lines.indexOf('Commands:');
    expect(lines.slice(at + 1, at + 3)).toEqual([
      '  1. orch job show job-00000001',
      '  2. orch verify job-00000001 --token <token>',
    ]);
    expect(lines.at(-1)).toBe('Details: orch factory status job-00000001 --json');
    for (const hidden of [
      'fingerprint',
      'fp-0123',
      'polls',
      'waitSeconds',
      'stray-file',
      'spec.md',
    ]) {
      expect(out).not.toContain(hidden);
    }
    expect(out).not.toContain('Blocked:');
    expect(out).not.toContain('Flaky:');
    expect(out).not.toContain('Notices:');
    expect(out).not.toContain('Acknowledge:');
  });

  it('prints notices and how to acknowledge them above Next', () => {
    const ack = 'orch job notice ack job-00000001 --through 42 --token <token>';
    const out = formatPlan(
      plan({
        notices: [
          { kind: 'base-moved', text: 'Base main moved.', at: null, by: null, eventId: null },
          { kind: 'message', text: 'main has the fix', at: 'x', by: 'human', eventId: 42 },
        ],
        noticeAck: ack,
      }),
    );
    const lines = out.split('\n');
    const at = lines.indexOf('Notices:');
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '  [base-moved] Base main moved.',
      '  [message] main has the fix',
      `Acknowledge: ${ack}`,
    ]);
    expect(lines.findIndex((l) => l.startsWith('Next:'))).toBeGreaterThan(at + 3);
  });

  it('prints notices without an Acknowledge line when nothing needs acking', () => {
    const out = formatPlan(
      plan({
        notices: [{ kind: 'pr-merged', text: 'PR merged.', at: null, by: null, eventId: null }],
      }),
    );
    expect(out).toContain('Notices:\n  [pr-merged] PR merged.\n\nNext:');
    expect(out).not.toContain('Acknowledge:');
  });

  it('names a likely flaky test with its reason', () => {
    const reason =
      'web/src/App.test.tsx > Loading > shows Refreshing failed in run 12 at abc1234; the job did not change web/src/App.test.tsx';
    const out = formatPlan(
      plan({
        flake: {
          runId: 12,
          head: 'abc1234def',
          check: 'check',
          tests: [{ file: 'web/src/App.test.tsx', name: 'Loading > shows Refreshing' }],
          rule: 'unchanged-file',
          reason,
          at: '2026-11-18T00:00:00.000Z',
          sharedWith: [],
        },
      }),
    );
    expect(out).toContain(`Flaky:   likely flaky test: ${reason}`);
  });

  it('says once that a test failing in other jobs is likely machine-wide', () => {
    const reason = 'web/src/App.test.tsx > Loading failed in run 12 at abc1234; why';
    const out = formatPlan(
      plan({
        flake: {
          runId: 12,
          head: 'abc1234def',
          check: 'check',
          tests: [{ file: 'web/src/App.test.tsx', name: 'Loading' }],
          rule: 'unchanged-file',
          reason,
          at: '2026-11-18T00:00:00.000Z',
          sharedWith: ['job-00000002', 'job-00000003'],
        },
      }),
    );
    expect(out.split('\n').filter((l) => l.startsWith('Flaky:'))).toEqual([
      `Flaky:   likely machine-wide flaky test (also failing in job-00000002, job-00000003): ${reason}`,
    ]);
  });

  it('shows (none), no PR, no agents, and the block reason for a human step', () => {
    const out = formatPlan(
      plan({
        step: 'needs-human',
        status: 'blocked',
        round: 0,
        reason: 'Fix it, then run orch factory resume job-00000001 --session <name>.',
        blockedReason: 'verification failed twice',
      }),
    );
    expect(out).toContain('Stage:   build\n');
    expect(out).toContain('PR:      -\n');
    expect(out).toContain('Reason:   Fix it, then run orch factory resume');
    expect(out).toContain('Blocked:  verification failed twice');
    expect(out).toContain('Commands:\n  (none)\n');
    expect(out).not.toContain('Agents:');
  });
});
