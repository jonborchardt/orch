/**
 * The Usage section's read model: tokens per UTC hour summed from the `usage` of assistant records
 * in the jobs' Claude Code transcripts, main session and subagents (decision
 * 2026-11-24-dashboard-token-usage-from-transcripts), plus the sessions already recorded in the
 * database (decision 2026-11-24-recorded-token-usage), which the caller passes in. Files are found
 * by `discoverSession` and read whole, through `readConfined` only, within `USAGE_LIMITS`. Nothing
 * here writes. `parseUsage` is pure.
 */
import { join } from 'node:path';

import {
  confined,
  discoverSession,
  type Found,
  readConfined,
  USAGE_LIMITS,
  type UsageLimits,
} from './transcript.ts';
import type { TokenCounts, UsageBucket, UsageJobRow, UsageRange, UsageView } from './types.ts';

export const USAGE_RANGES: readonly UsageRange[] = [24, 168, 720];
export const HOUR_MS = 3_600_000;

/** One assistant message's usage, keyed by its message id, in the UTC hour (ms) of its line. */
export interface UsageRecord extends TokenCounts {
  id: string;
  hour: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
export const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
export function add(to: TokenCounts, c: TokenCounts) {
  to.input += c.input;
  to.output += c.output;
  to.cacheRead += c.cacheRead;
  to.cacheCreation += c.cacheCreation;
}

/**
 * The usage records of JSONL transcript text, in line order. Assistant records with a message id
 * and a `usage` object only; malformed lines and, unless `sidechain` (a subagent file), sidechain
 * records are skipped, as in `parseTranscript`. A missing count is 0. Lines sharing a message id
 * (split content blocks) are all returned; the caller keeps the last.
 */
export function parseUsage(text: string, sidechain: boolean): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(r) || r['type'] !== 'assistant') continue;
    if (!sidechain && r['isSidechain'] === true) continue;
    const t = typeof r['timestamp'] === 'string' ? Date.parse(r['timestamp']) : NaN;
    const msg = r['message'];
    if (Number.isNaN(t) || !isObj(msg)) continue;
    const id = msg['id'];
    const u = msg['usage'];
    if (typeof id !== 'string' || !id || !isObj(u)) continue;
    out.push({
      id,
      hour: Math.floor(t / HOUR_MS) * HOUR_MS,
      input: count(u['input_tokens']),
      output: count(u['output_tokens']),
      cacheRead: count(u['cache_read_input_tokens']),
      cacheCreation: count(u['cache_creation_input_tokens']),
    });
  }
  return out;
}

/** One UTC hour's counts; `hour` is the hour's start in epoch ms. */
export interface HourCounts extends TokenCounts {
  hour: number;
}

/** A session's usage record and the subagent id of the file it was read from (null: main). */
export interface SessionRecord extends UsageRecord {
  agent: string | null;
}

/**
 * What reading one session gave: its records in read order and the first problem, if any, and
 * the real subagents directory ('' when absent or refused).
 */
export interface SessionRead {
  recs: SessionRecord[];
  sub: string;
  problem: string | null;
  /** Bytes read, for the caller's budget. */
  bytes: number;
}

/**
 * Read session `ref`'s main file, then its subagent files by name, within `L` and `budget`
 * bytes. With `since`, a file last written before it is skipped (nothing in it can fall in the
 * range); with null every file is read. Files that cannot be read are skipped and the first
 * reason is returned; the rest are still read.
 */
export function readSessionUsage(
  claudeDir: string,
  ref: string,
  L: UsageLimits,
  since: number | null,
  budget: number,
): SessionRead {
  const recs: SessionRecord[] = [];
  let problem: string | null = null;
  let bytes = 0;
  const miss = (reason: string) => {
    problem ??= reason;
  };
  const found = discoverSession(claudeDir, ref);
  if (found === 'no-projects') {
    return {
      recs,
      sub: '',
      problem: `No Claude Code projects directory under ${claudeDir}.`,
      bytes,
    };
  }
  if (found === 'not-found') {
    return { recs, sub: '', problem: `Transcript ${ref}.jsonl was not found.`, bytes };
  }
  if (found.subRefused)
    miss(`The subagents directory of ${ref} is outside the projects directory.`);
  const ids = new Map(found.agents.map((a) => [a.name, a.id]));
  const names = [...ids.keys()].sort();
  if (names.length > L.USAGE_SUBAGENT_FILES) {
    miss(`Session ${ref} has more than ${String(L.USAGE_SUBAGENT_FILES)} subagent files.`);
  }
  const files: { file: Found | null; name: string; root: string; agent: string | null }[] = [
    { file: found.main, name: `${ref}.jsonl`, root: found.projects, agent: null },
    ...names.slice(0, L.USAGE_SUBAGENT_FILES).map((name) => ({
      file: confined(join(found.sub, name), found.sub),
      name,
      root: found.sub,
      agent: ids.get(name) ?? null,
    })),
  ];
  for (const { file, name, root, agent } of files) {
    if (!file) {
      miss(`${name} is outside its directory or not a regular file.`);
      continue;
    }
    if (since !== null && file.mtimeMs < since) continue;
    if (file.size > L.USAGE_FILE_BYTES) {
      miss(`${name} is larger than the ${String(L.USAGE_FILE_BYTES)}-byte per-file cap.`);
      continue;
    }
    if (file.size > budget - bytes) {
      miss(`The ${String(L.USAGE_TOTAL_BYTES)}-byte read budget ran out before ${name}.`);
      continue;
    }
    const got = readConfined(file.path, root, L.USAGE_FILE_BYTES);
    if (!got || got.size > L.USAGE_FILE_BYTES) {
      miss(`${name} could not be read.`);
      continue;
    }
    bytes += got.buf.length;
    for (const r of parseUsage(got.buf.toString('utf8'), agent !== null))
      recs.push({ ...r, agent });
  }
  return { recs, sub: found.sub, problem, bytes };
}

/** Records summed per hour, the last record for a message id counted; hours in order. */
export function hourCounts(recs: readonly UsageRecord[]): HourCounts[] {
  const last = new Map<string, UsageRecord>();
  for (const r of recs) last.set(r.id, r);
  const hours = new Map<number, HourCounts>();
  for (const r of last.values()) {
    let h = hours.get(r.hour);
    if (!h) {
      h = { hour: r.hour, ...zero() };
      hours.set(r.hour, h);
    }
    add(h, r);
  }
  return [...hours.values()].sort((a, b) => a.hour - b.hour);
}

/** A job as the read model needs it: its sessions in attach order, oldest first, and its span. */
export interface UsageJob {
  id: string;
  title: string;
  refs: string[];
  /** Span in epoch ms: first attach to now (unfinished) or `max(updatedAt, completedAt)`. */
  start: number;
  end: number;
}

/** Sessions already recorded: every recorded ref, and the rows with an hour in the range. */
export interface StoredUsage {
  refs: ReadonlySet<string>;
  rows: readonly { jobId: string; hours: readonly HourCounts[] }[];
}

/** A job's span end: `now` while unfinished, else the later of `updatedAt` and `completedAt`. */
export function spanEnd(
  job: { updatedAt: string; completedAt: string | null },
  finished: boolean,
  now: number,
): number {
  if (!finished) return now;
  return Math.max(
    Date.parse(job.updatedAt),
    job.completedAt ? Date.parse(job.completedAt) : -Infinity,
  );
}

/** The first and last bucket (epoch ms) of the `hours` range ending with the hour of `now`. */
export function rangeOf(hours: UsageRange, now: number): { first: number; last: number } {
  const last = Math.floor(now / HOUR_MS) * HOUR_MS;
  return { first: last - (hours - 1) * HOUR_MS, last };
}

/** A job's sessions are read live when it has any and its span overlaps the range. */
export const spanOverlaps = (j: UsageJob, r: { first: number; last: number }): boolean =>
  j.refs.length > 0 && j.end >= r.first && j.start < r.last + HOUR_MS;

/**
 * Tokens per UTC hour over the `hours` buckets ending with the one holding `now`: the `stored`
 * rows by their own hours, plus the sessions not recorded yet, read live from every job whose
 * span overlaps the range. One fixed live order (jobs by id, sessions oldest first, main file
 * then subagent files by name, lines in order); the last record for a message id is counted, in
 * its job and hour. A job any of whose live files cannot be read flags every bucket of its span;
 * a stored session never flags anything.
 */
export function readTokenUsage(
  claudeDir: string,
  input: readonly UsageJob[],
  hours: UsageRange,
  now: number,
  limits: Partial<UsageLimits> = {},
  stored: StoredUsage = { refs: new Set(), rows: [] },
): UsageView {
  const L = { ...USAGE_LIMITS, ...limits };
  const range = rangeOf(hours, now);
  const { first, last: lastHour } = range;
  const inRange = (h: number) => h >= first && h <= lastHour;
  const storedJobs = new Set(
    stored.rows.filter((r) => r.hours.some((h) => inRange(h.hour))).map((r) => r.jobId),
  );
  const jobs = input
    .filter((j) => spanOverlaps(j, range) || storedJobs.has(j.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let budget = L.USAGE_TOTAL_BYTES;
  const kept = new Map<string, { job: string; rec: UsageRecord }>();
  const missing = new Map<string, string>();

  for (const job of jobs) {
    if (!spanOverlaps(job, range)) continue;
    for (const ref of job.refs) {
      if (stored.refs.has(ref)) continue;
      const got = readSessionUsage(claudeDir, ref, L, first, budget);
      budget -= got.bytes;
      if (got.problem !== null && !missing.has(job.id)) missing.set(job.id, got.problem);
      for (const rec of got.recs) kept.set(rec.id, { job: job.id, rec });
    }
  }

  const buckets: UsageBucket[] = [];
  for (let h = first; h <= lastHour; h += HOUR_MS) {
    const flagged = jobs
      .filter((j) => missing.has(j.id) && j.start < h + HOUR_MS && j.end >= h)
      .map((j) => j.id);
    buckets.push({ hour: new Date(h).toISOString(), ...zero(), missing: flagged });
  }
  const rows = new Map<string, UsageJobRow>(
    jobs.map((j) => [
      j.id,
      { id: j.id, title: j.title, ...zero(), missing: missing.get(j.id) ?? null },
    ]),
  );
  const total = zero();
  const tally = (job: string, hour: number, c: TokenCounts) => {
    const bucket = buckets[(hour - first) / HOUR_MS];
    if (!inRange(hour) || !bucket) return;
    add(bucket, c);
    add(total, c);
    const row = rows.get(job);
    if (row) add(row, c);
  };
  for (const { job, rec } of kept.values()) tally(job, rec.hour, rec);
  for (const r of stored.rows) for (const h of r.hours) tally(r.jobId, h.hour, h);
  return {
    hours,
    buckets,
    total: { ...total, complete: missing.size === 0 },
    jobs: [...rows.values()],
  };
}
