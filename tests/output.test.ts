import { describe, expect, it } from 'vitest';

import { formatFactoryList } from '../src/cli/output.ts';
import type { FactoryRow } from '../src/ops/dispatch.ts';

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
