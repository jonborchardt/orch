/** The Usage section's read model: parsing, read order, gaps, bounds, and confinement (ticket 0127). */
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HOUR_MS,
  parseUsage,
  readTokenUsage,
  spanEnd,
  type UsageJob,
} from '../src/server/token-usage.ts';
import type { UsageView } from '../src/server/types.ts';
import { tempDir } from './helpers.ts';
import { at, U, usage, user, writeAgent, writeSession } from './transcript-fixture.ts';

const U2 = '22222222-3333-4444-8555-666666666666';
const U3 = '33333333-4444-4555-8666-777777777777';
const T0 = Date.parse(at(0)); // 2026-11-20T09:00Z
const H = (n: number) => T0 + n * HOUR_MS;
/** 12:30 UTC: the range's last bucket is 12:00, its first 13:00 the day before. */
const NOW = H(3) + 30 * 60_000;
const job = (id: string, refs: string[], over: Partial<UsageJob> = {}): UsageJob => ({
  id,
  title: `title ${id}`,
  refs,
  start: T0,
  end: NOW,
  ...over,
});
const bucket = (v: UsageView, hour: number) =>
  v.buckets.find((b) => b.hour === new Date(hour).toISOString());

describe('parseUsage (AC1)', () => {
  it('counts each kind into the UTC hour, skipping sidechain-in-main, no-usage, and malformed lines', () => {
    const text = [
      usage(60, 'm1', { i: 1, o: 2, r: 3, c: 4 }),
      usage(61, 'm1', { i: 1, o: 2, r: 3, c: 4 }),
      usage(3700, 'm2', { o: 9 }),
      usage(62, 'side', { i: 50 }, { isSidechain: true }),
      user(63, 'hi'),
      JSON.stringify({
        type: 'assistant',
        timestamp: at(64),
        message: { usage: { input_tokens: 5 } },
      }),
      JSON.stringify({ type: 'assistant', timestamp: at(65), message: { id: 'nousage' } }),
      '{"type":"assistant","timest',
      '',
    ].join('\n');
    const recs = parseUsage(text, false);
    expect(recs).toEqual([
      { id: 'm1', hour: H(0), input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      { id: 'm1', hour: H(0), input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      { id: 'm2', hour: H(1), input: 0, output: 9, cacheRead: 0, cacheCreation: 0 },
    ]);
    // Split lines of one message count once once the read model dedupes them.
    const claude = tempDir('claude-');
    writeSession(claude, 'p', text);
    const v = readTokenUsage(claude, [job('job-00000001', [U])], 24, NOW);
    expect(bucket(v, H(0))).toMatchObject({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    // In a subagent file every record is a sidechain and all are counted.
    expect(parseUsage(usage(0, 's1', { i: 7 }, { isSidechain: true }), true)).toMatchObject([
      { id: 's1', input: 7 },
    ]);
  });
});

describe('readTokenUsage', () => {
  it('sums main and subagent files of two jobs in the fixed read order (AC2)', () => {
    const claude = tempDir('claude-');
    const p = writeSession(
      claude,
      'E--repo',
      [
        usage(0, 'm1', { i: 10, o: 1, r: 100, c: 5 }),
        usage(1, 'm1', { i: 10, o: 1, r: 100, c: 5 }),
        usage(2, 'side', { i: 999 }, { isSidechain: true }),
        usage(3600, 'm2', { i: 20 }),
      ].join('\n'),
    );
    const side = { isSidechain: true };
    writeAgent(p, 'b2', usage(2 * 3600, 'm2', { i: 30 }, side));
    writeAgent(p, 'a1', usage(1800, 'm3', { o: 7 }, side));
    writeSession(claude, 'E--other', usage(3600, 'm4', { i: 1000 }), U2);
    const v = readTokenUsage(
      claude,
      [job('job-0000000b', [U2]), job('job-0000000a', [U])],
      24,
      NOW,
    );
    expect(v.buckets).toHaveLength(24);
    expect(v.buckets[0]?.hour).toBe(new Date(H(-20)).toISOString());
    expect(v.buckets[23]?.hour).toBe(new Date(H(3)).toISOString());
    const z = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    expect(bucket(v, H(0))).toEqual({
      hour: at(0),
      input: 10,
      output: 8,
      cacheRead: 100,
      cacheCreation: 5,
      missing: [],
    });
    expect(bucket(v, H(1))).toMatchObject({ ...z, input: 1000 });
    // m2 is counted once, from the subagent line that comes after the main file.
    expect(bucket(v, H(2))).toMatchObject({ ...z, input: 30 });
    // Readable files with nothing in an hour: an unflagged zero (AC3).
    expect(bucket(v, H(3))).toEqual({ hour: new Date(H(3)).toISOString(), ...z, missing: [] });
    expect(v.total).toEqual({
      input: 1040,
      output: 8,
      cacheRead: 100,
      cacheCreation: 5,
      complete: true,
    });
    expect(v.jobs).toEqual([
      {
        id: 'job-0000000a',
        title: 'title job-0000000a',
        input: 40,
        output: 8,
        cacheRead: 100,
        cacheCreation: 5,
        missing: null,
      },
      { id: 'job-0000000b', title: 'title job-0000000b', ...z, input: 1000, missing: null },
    ]);
  });

  it("flags a missing transcript's span and marks the totals incomplete (AC3)", () => {
    const claude = tempDir('claude-');
    writeSession(claude, 'p', usage(0, 'm1', { i: 1 }));
    // Finished at 11:01 by updatedAt, which is later than completedAt.
    const end = spanEnd({ updatedAt: at(2 * 3600 + 60), completedAt: at(3600) }, true, NOW);
    expect(end).toBe(H(2) + 60_000);
    expect(spanEnd({ updatedAt: at(0), completedAt: null }, false, NOW)).toBe(NOW);
    const v = readTokenUsage(
      claude,
      [job('job-00000001', [U]), job('job-00000002', [U3], { end })],
      24,
      NOW,
    );
    for (const h of [0, 1, 2]) expect(bucket(v, H(h))?.missing).toEqual(['job-00000002']);
    expect(bucket(v, H(3))?.missing).toEqual([]);
    expect(bucket(v, H(-1))?.missing).toEqual([]);
    expect(v.total.complete).toBe(false);
    expect(v.total.input).toBe(1);
    expect(v.jobs.find((j) => j.id === 'job-00000002')?.missing).toContain(`${U3}.jsonl`);
    expect(v.jobs.find((j) => j.id === 'job-00000001')?.missing).toBeNull();
  });

  it('reports a file over the per-file cap as missing without parsing it (AC4)', () => {
    const claude = tempDir('claude-');
    const small = usage(0, 'm1', { i: 1 });
    const cap = small.length + 10;
    const p = writeSession(claude, 'p', small);
    writeAgent(p, 'big', usage(10, 'm2', { i: 5 }, { isSidechain: true }).padEnd(cap + 100));
    const v = readTokenUsage(claude, [job('job-00000001', [U])], 24, NOW, {
      USAGE_FILE_BYTES: cap,
    });
    expect(v.total).toMatchObject({ input: 1, complete: false });
    expect(v.jobs[0]?.missing).toContain('agent-big.jsonl');
    expect(bucket(v, H(0))?.missing).toEqual(['job-00000001']);
  });

  it('refuses files and a subagents directory leading outside projects, as the Session tab does (AC4)', () => {
    const outside = tempDir('outside-');
    writeFileSync(join(outside, `${U}.jsonl`), usage(0, 'out-main', { i: 111 }));
    writeFileSync(
      join(outside, 'agent-z1.jsonl'),
      usage(0, 'out-agent', { i: 222 }, { isSidechain: true }),
    );
    const junction = (target: string, path: string) => {
      symlinkSync(target, path, 'junction');
    };
    const read = (claude: string) => readTokenUsage(claude, [job('job-00000001', [U])], 24, NOW);

    // A main "file" that is a junction out of projects: not found, so missing.
    const a = tempDir('claude-');
    mkdirSync(join(a, 'projects', 'p'), { recursive: true });
    junction(outside, join(a, 'projects', 'p', `${U}.jsonl`));
    expect(read(a).total).toMatchObject({ input: 0, complete: false });

    // A subagents directory that is a junction out of projects.
    const b = tempDir('claude-');
    const pb = writeSession(b, 'p', usage(0, 'm1', { i: 1 }));
    mkdirSync(join(pb, U));
    junction(outside, join(pb, U, 'subagents'));
    const vb = read(b);
    expect(vb.total).toMatchObject({ input: 1, complete: false });
    expect(vb.jobs[0]?.missing).toContain('subagents');

    // A subagent entry that is a junction out of subagents/.
    const c = tempDir('claude-');
    const pc = writeSession(c, 'p', usage(0, 'm1', { i: 1 }));
    writeAgent(pc, 'ok', usage(1, 'm2', { i: 2 }, { isSidechain: true }));
    junction(outside, join(pc, U, 'subagents', 'agent-z9.jsonl'));
    const vc = read(c);
    expect(vc.total).toMatchObject({ input: 3, complete: false });
    expect(vc.jobs[0]?.missing).toContain('agent-z9.jsonl');
  });

  it('skips a job whose span ends before the range, and files last written before it (AC5)', () => {
    const claude = tempDir('claude-');
    // In-range records, but the job's span ended two days earlier: never read.
    writeSession(claude, 'p', usage(0, 'm1', { i: 5 }));
    const early = { start: H(-60), end: H(-48) };
    const v = readTokenUsage(
      claude,
      [job('job-00000001', [U], early), job('job-00000002', [U3], early)],
      24,
      NOW,
    );
    expect(v.jobs).toEqual([]);
    expect(v.total).toMatchObject({ input: 0, complete: true });
    expect(v.buckets.every((b) => b.missing.length === 0)).toBe(true);

    // A file whose mtime is before the range start is not read, and that is not a gap.
    const old = H(-30) / 1000;
    utimesSync(join(claude, 'projects', 'p', `${U}.jsonl`), old, old);
    const w = readTokenUsage(claude, [job('job-00000001', [U])], 24, NOW);
    expect(w.total).toMatchObject({ input: 0, complete: true });
    expect(w.jobs[0]?.missing).toBeNull();
  });
});
