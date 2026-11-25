/**
 * The Usage section's read model: tokens per UTC hour summed from the `usage` of assistant records
 * in the jobs' Claude Code transcripts, main session and subagents (decision
 * 2026-11-24-dashboard-token-usage-from-transcripts). Files are found by `discoverSession` and read
 * whole, through `readConfined` only, within `USAGE_LIMITS`. Nothing is cached or written.
 * `parseUsage` is pure.
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
const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
function add(to: TokenCounts, c: TokenCounts) {
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

/** A job as the read model needs it: its sessions in attach order, oldest first, and its span. */
export interface UsageJob {
  id: string;
  title: string;
  refs: string[];
  /** Span in epoch ms: first attach to now (unfinished) or `max(updatedAt, completedAt)`. */
  start: number;
  end: number;
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

/**
 * Tokens per UTC hour over the `hours` buckets ending with the one holding `now`, read from every
 * job whose span overlaps the range. One fixed order (jobs by id, sessions oldest first, main file
 * then subagent files by name, lines in order); the last record for a message id is counted, in
 * its job and hour. A job any of whose files cannot be read flags every bucket of its span.
 */
export function readTokenUsage(
  claudeDir: string,
  input: readonly UsageJob[],
  hours: UsageRange,
  now: number,
  limits: Partial<UsageLimits> = {},
): UsageView {
  const L = { ...USAGE_LIMITS, ...limits };
  const lastHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const first = lastHour - (hours - 1) * HOUR_MS;
  const jobs = input
    .filter((j) => j.refs.length > 0 && j.end >= first && j.start < lastHour + HOUR_MS)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let budget = L.USAGE_TOTAL_BYTES;
  const kept = new Map<string, { job: string; rec: UsageRecord }>();
  const missing = new Map<string, string>();

  for (const job of jobs) {
    const miss = (reason: string) => {
      if (!missing.has(job.id)) missing.set(job.id, reason);
    };
    for (const ref of job.refs) {
      const found = discoverSession(claudeDir, ref);
      if (found === 'no-projects') {
        miss(`No Claude Code projects directory under ${claudeDir}.`);
        continue;
      }
      if (found === 'not-found') {
        miss(`Transcript ${ref}.jsonl was not found.`);
        continue;
      }
      if (found.subRefused)
        miss(`The subagents directory of ${ref} is outside the projects directory.`);
      const names = found.agents.map((a) => a.name).sort();
      if (names.length > L.USAGE_SUBAGENT_FILES) {
        miss(`Session ${ref} has more than ${String(L.USAGE_SUBAGENT_FILES)} subagent files.`);
      }
      const files: { file: Found | null; name: string; root: string; sidechain: boolean }[] = [
        { file: found.main, name: `${ref}.jsonl`, root: found.projects, sidechain: false },
        ...names.slice(0, L.USAGE_SUBAGENT_FILES).map((name) => ({
          file: confined(join(found.sub, name), found.sub),
          name,
          root: found.sub,
          sidechain: true,
        })),
      ];
      for (const { file, name, root, sidechain } of files) {
        if (!file) {
          miss(`${name} is outside its directory or not a regular file.`);
          continue;
        }
        // Last written before the range began: nothing in it can fall inside the range.
        if (file.mtimeMs < first) continue;
        if (file.size > L.USAGE_FILE_BYTES) {
          miss(`${name} is larger than the ${String(L.USAGE_FILE_BYTES)}-byte per-file cap.`);
          continue;
        }
        if (file.size > budget) {
          miss(`The ${String(L.USAGE_TOTAL_BYTES)}-byte read budget ran out before ${name}.`);
          continue;
        }
        const got = readConfined(file.path, root, L.USAGE_FILE_BYTES);
        if (!got || got.size > L.USAGE_FILE_BYTES) {
          miss(`${name} could not be read.`);
          continue;
        }
        budget -= got.buf.length;
        for (const rec of parseUsage(got.buf.toString('utf8'), sidechain)) {
          kept.set(rec.id, { job: job.id, rec });
        }
      }
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
  for (const { job, rec } of kept.values()) {
    const bucket = buckets[(rec.hour - first) / HOUR_MS];
    if (rec.hour < first || !bucket) continue;
    add(bucket, rec);
    add(total, rec);
    const row = rows.get(job);
    if (row) add(row, rec);
  }
  return {
    hours,
    buckets,
    total: { ...total, complete: missing.size === 0 },
    jobs: [...rows.values()],
  };
}
