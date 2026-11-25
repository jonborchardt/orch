/** The Usage section's read model: parsing, read order, gaps, bounds, and confinement (ticket 0127). */
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordSession } from '../src/ops/token-usage.ts';
import { tokenUsage } from '../src/server/api.ts';
import { attachSession, createJob } from '../src/storage/jobs.ts';
import { events, jobs } from '../src/storage/schema.ts';
import { recordedRefs } from '../src/storage/usage.ts';

import {
  HOUR_MS,
  parseUsage,
  readTokenUsage,
  spanEnd,
  type UsageJob,
} from '../src/server/token-usage.ts';
import type { UsageView } from '../src/server/types.ts';
import { tempDir, type TempStore, tempStore } from './helpers.ts';
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

describe('recorded usage in the read model (ticket 0144)', () => {
  let store: TempStore;
  let claude: string;
  const saved = process.env['CLAUDE_CONFIG_DIR'];
  beforeEach(() => {
    store = tempStore();
    claude = tempDir('claude-');
    process.env['CLAUDE_CONFIG_DIR'] = claude;
  });
  afterEach(() => {
    process.env['CLAUDE_CONFIG_DIR'] = saved;
    store.cleanup();
  });
  /** A job attached to `refs` at 09:00, finished at 12:00 when `done`. */
  const mkJob = (refs: string[], done: boolean): string => {
    const j = createJob(store, {
      title: `job ${refs.join(',')}`,
      description: 'usage',
      repo: 'github.com/acme/alpha',
      repoPath: claude,
      baseBranch: 'main',
    });
    for (const ref of refs) {
      attachSession(store, j.id, { session: { provider: 'claude-code', ref, cwd: null } });
    }
    store.db
      .update(events)
      .set({ createdAt: at(0) })
      .where(eq(events.jobId, j.id))
      .run();
    if (done) {
      const end = at(3 * 3600);
      store.db
        .update(jobs)
        .set({ stage: 'completed', status: 'completed', updatedAt: end, completedAt: end })
        .where(eq(jobs.id, j.id))
        .run();
    }
    return j.id;
  };
  const file = (ref: string) => join(claude, 'projects', 'p', `${ref}.jsonl`);

  it('sums a stored ref whose transcript is gone, unflagged (AC4)', () => {
    writeSession(
      claude,
      'p',
      [usage(0, 'm1', { i: 4, o: 1 }), usage(3600, 'm2', { r: 9 })].join('\n'),
    );
    const id = mkJob([U], true);
    expect(recordSession(store, id, U, 'runner')).toBeNull();
    rmSync(file(U));
    const v = tokenUsage(store, '24', NOW);
    expect(bucket(v, H(0))).toMatchObject({ input: 4, output: 1, missing: [] });
    expect(bucket(v, H(1))).toMatchObject({ cacheRead: 9, missing: [] });
    expect(v.jobs).toMatchObject([{ id, input: 4, cacheRead: 9, missing: null }]);
    expect(v.total.complete).toBe(true);
  });

  it('reads an unfinished job live without storing; a finished job is stored on read (AC5)', () => {
    writeSession(claude, 'p', usage(0, 'm1', { i: 3 }), U);
    writeSession(claude, 'p', usage(60, 'm2', { i: 5 }), U2);
    mkJob([U], false);
    const done = mkJob([U2], true);
    expect(tokenUsage(store, '24', NOW).total.input).toBe(8);
    expect(recordedRefs(store.db)).toEqual(new Set([U2]));
    rmSync(file(U2));
    const v = tokenUsage(store, '24', NOW);
    expect(v.total).toMatchObject({ input: 8, complete: true });
    expect(v.jobs.find((j) => j.id === done)).toMatchObject({ input: 5, missing: null });
    expect(recordedRefs(store.db)).toEqual(new Set([U2]));
  });

  it('sums stored and live refs of one job like the live-only read, by stored hours (AC6)', () => {
    writeSession(
      claude,
      'p',
      [usage(0, 'm1', { i: 2 }), usage(-30 * 3600, 'm0', { o: 7 })].join('\n'),
      U,
    );
    writeSession(claude, 'p', usage(7200, 'm2', { i: 10, c: 1 }), U2);
    const id = mkJob([U, U2], false);
    const live = readTokenUsage(claude, [job(id, [U, U2], { title: `job ${U},${U2}` })], 24, NOW);
    expect(recordSession(store, id, U, 'backfill')).toBeNull();
    const v = tokenUsage(store, '24', NOW);
    expect(v.total).toEqual(live.total);
    expect(v.buckets).toEqual(live.buckets);
    expect(v.jobs).toEqual(live.jobs);
    expect(v.total).toMatchObject({ input: 12, output: 0, cacheCreation: 1 });
    // The stored 30-hours-ago record falls in the 168- and 720-hour views only.
    expect(tokenUsage(store, '168', NOW).total).toMatchObject({ input: 12, output: 7 });
    expect(tokenUsage(store, '720', NOW).total).toMatchObject({ input: 12, output: 7 });
  });

  it('lists a job with stored rows and no attached session only where a stored hour falls (AC10)', () => {
    writeSession(claude, 'p', usage(0, 'm1', { i: 6 }), U);
    const id = mkJob([], true);
    expect(recordSession(store, id, U, 'backfill')).toBeNull();
    for (const h of ['24', '168', '720']) {
      const v = tokenUsage(store, h, NOW);
      expect(v.jobs).toMatchObject([{ id, input: 6, missing: null }]);
      expect(v.buckets.every((b) => b.missing.length === 0)).toBe(true);
    }
    const later = NOW + 10 * 24 * HOUR_MS;
    expect(tokenUsage(store, '24', later).jobs).toEqual([]);
    expect(tokenUsage(store, '168', later).jobs).toEqual([]);
    expect(tokenUsage(store, '720', later).jobs).toMatchObject([{ id, input: 6 }]);
  });

  it('stores nothing for a session with a file over a cap or unreadable, and reads it live (AC11)', () => {
    const small = usage(0, 'm1', { i: 1 });
    const p = writeSession(claude, 'p', small, U);
    writeAgent(
      p,
      'big',
      usage(10, 'm2', { i: 5 }, { isSidechain: true }).padEnd(small.length + 100),
    );
    const id = mkJob([U], true);
    const cap = { USAGE_FILE_BYTES: small.length + 10 };
    expect(recordSession(store, id, U, 'runner', claude, cap)).toContain('agent-big.jsonl');
    expect(recordedRefs(store.db).size).toBe(0);
    // An unreadable subagent entry (a junction out of subagents/) blocks the read-path recording.
    symlinkSync(tempDir('outside-'), join(p, U, 'subagents', 'agent-z9.jsonl'), 'junction');
    const v = tokenUsage(store, '24', NOW);
    expect(recordedRefs(store.db).size).toBe(0);
    expect(v.total).toMatchObject({ input: 6, complete: false });
    expect(v.jobs[0]?.missing).toContain('agent-z9.jsonl');
    expect(bucket(v, H(0))?.missing).toEqual([id]);
  });

  it('stores a session whose files predate the range in full (AC11)', () => {
    writeSession(claude, 'p', usage(0, 'm1', { i: 3 }), U);
    const old = H(-30) / 1000;
    utimesSync(file(U), old, old);
    const id = mkJob([U], false);
    // Live, the file is skipped by its mtime; recorded, it is read whole.
    expect(tokenUsage(store, '24', NOW).total.input).toBe(0);
    expect(recordSession(store, id, U, 'runner')).toBeNull();
    expect(tokenUsage(store, '24', NOW).total.input).toBe(3);
  });
});
