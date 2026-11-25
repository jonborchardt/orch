/**
 * Recorded token usage (decision 2026-11-24-recorded-token-usage): a session's counts per UTC
 * hour, parsed once from its whole transcript and stored on its job, so the Usage section sums
 * rows instead of re-reading files. Recording happens only when the controller's child exits,
 * when the Usage read model reads a finished job's session live, and in `orch usage backfill`.
 * The counts are display evidence: nothing decides from them. The only caller of
 * `storage/usage.ts`.
 */
import { readdirSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { canonicalPath, claudeHome } from '../core/paths.ts';
import { UUID } from '../core/session.ts';
import { type Status, TERMINAL_STATUSES } from '../core/workflow.ts';
import {
  add,
  hourCounts,
  rangeOf,
  readSessionUsage,
  spanOverlaps,
  type StoredUsage,
  type UsageJob,
  zero,
} from '../server/token-usage.ts';
import { confined, readConfined, USAGE_LIMITS, type UsageLimits } from '../server/transcript.ts';
import type { TokenCounts, UsageRange } from '../server/types.ts';
import type { Store } from '../storage/client.ts';
import { listJobs } from '../storage/jobs.ts';
import type { TokenUsageRow } from '../storage/schema.ts';
import { insertUsage, recordedRefs, usageInRange, usageOfJob } from '../storage/usage.ts';

/** Bytes read from the start of a transcript to find its `cwd` during a backfill. */
const CWD_HEAD_BYTES = 1024 * 1024;

/**
 * Record session `ref` on `jobId` from its main file and every subagent file, read in full. When
 * any file is missing, refused, over a cap, or unreadable nothing is stored and the reason is
 * returned; null when the session is stored (now or already).
 */
export function recordSession(
  store: Store,
  jobId: string,
  ref: string,
  source: TokenUsageRow['source'],
  claudeDir: string = claudeHome(),
  limits: Partial<UsageLimits> = {},
): string | null {
  const L = { ...USAGE_LIMITS, ...limits };
  const got = readSessionUsage(claudeDir, ref, L, null, L.USAGE_TOTAL_BYTES);
  if (got.problem !== null) return got.problem;
  insertUsage(store, { ref, jobId, source, hours: hourCounts(got.recs) });
  return null;
}

/**
 * What the Usage read model takes from the database for `hours` ending at `at`. First records
 * every unrecorded session of a finished job whose span overlaps the range (an unfinished job's
 * sessions are always read live). A recording that fails is skipped: the session stays live-read.
 */
export function storedUsage(
  store: Store,
  jobs: readonly (UsageJob & { terminal: boolean })[],
  hours: UsageRange,
  at: number,
  claudeDir: string = claudeHome(),
): StoredUsage {
  const range = rangeOf(hours, at);
  const before = recordedRefs(store.db);
  for (const j of jobs) {
    if (!j.terminal || !spanOverlaps(j, range)) continue;
    for (const ref of j.refs) {
      if (before.has(ref)) continue;
      try {
        recordSession(store, j.id, ref, 'read', claudeDir);
      } catch {
        // Evidence only: a failed write never fails the read; the session is read live.
      }
    }
  }
  return { refs: recordedRefs(store.db), rows: usageInRange(store.db, range.first, range.last) };
}

export interface BackfillReport {
  /** Sessions recorded by this run, per job. */
  recorded: { jobId: string; refs: string[] }[];
  /** Jobs with a worktree path that no transcript's `cwd` names. */
  unmatchedJobs: { jobId: string; worktreePath: string }[];
  /** Matches not recorded because the job is not finished yet; a later run picks them up. */
  unfinished: { jobId: string; ref: string; status: Status }[];
  /** Transcripts whose `cwd` is under the orch worktrees root but is no job's worktree. */
  orphans: { ref: string; cwd: string }[];
  /** Transcript files that could not be used. */
  skipped: { file: string; reason: string }[];
}

/** The `cwd` of the first record carrying one in JSONL `text`, or null. */
function firstCwd(text: string): string | null {
  for (const line of text.split('\n')) {
    try {
      const r: unknown = JSON.parse(line);
      if (typeof r === 'object' && r !== null && 'cwd' in r && typeof r.cwd === 'string') {
        return r.cwd;
      }
    } catch {
      // Malformed or cut-off line.
    }
  }
  return null;
}

/**
 * `orch usage backfill`: record every finished job's unrecorded sessions found under
 * `<claudeDir>/projects/*\/<uuid>.jsonl`. A transcript belongs to a job only when its first `cwd`
 * is, by `canonicalPath`, the job's worktree path; nothing else assigns one.
 */
export function backfillUsage(store: Store, claudeDir: string = claudeHome()): BackfillReport {
  const report: BackfillReport = {
    recorded: [],
    unmatchedJobs: [],
    unfinished: [],
    orphans: [],
    skipped: [],
  };
  const jobs = listJobs(store.db).filter((j) => j.worktreePath !== null);
  const byPath = new Map(jobs.map((j) => [canonicalPath(j.worktreePath ?? ''), j]));
  const root = canonicalPath(join(store.paths.data, 'worktrees')) + sep;
  const matched = new Set<string>();
  const stored = recordedRefs(store.db);
  const recorded = new Map<string, string[]>();

  const list = (dir: string) => {
    try {
      return readdirSync(dir).sort();
    } catch {
      return [];
    }
  };
  let projects = '';
  try {
    projects = realpathSync(join(claudeDir, 'projects'));
  } catch {
    // No projects directory: nothing to match.
  }
  for (const dir of projects ? list(projects) : []) {
    for (const name of list(join(projects, dir))) {
      const ref = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
      if (!UUID.test(ref)) continue;
      const path = join(projects, dir, name);
      const file = confined(path, projects);
      const got = file && readConfined(file.path, projects, CWD_HEAD_BYTES);
      if (!got) {
        report.skipped.push({ file: path, reason: 'outside projects, not a file, or unreadable' });
        continue;
      }
      const cwd = firstCwd(got.buf.toString('utf8'));
      if (cwd === null) {
        report.skipped.push({
          file: path,
          reason: `no cwd in its first ${String(CWD_HEAD_BYTES)} bytes`,
        });
        continue;
      }
      const canon = canonicalPath(cwd);
      const job = byPath.get(canon);
      if (!job) {
        if (canon.startsWith(root)) report.orphans.push({ ref, cwd });
        continue;
      }
      matched.add(job.id);
      if (stored.has(ref)) continue;
      if (!TERMINAL_STATUSES.includes(job.status)) {
        report.unfinished.push({ jobId: job.id, ref, status: job.status });
        continue;
      }
      const problem = recordSession(store, job.id, ref, 'backfill', claudeDir);
      if (problem !== null) {
        report.skipped.push({ file: path, reason: problem });
        continue;
      }
      stored.add(ref);
      recorded.set(job.id, [...(recorded.get(job.id) ?? []), ref]);
    }
  }
  report.recorded = [...recorded].map(([jobId, refs]) => ({ jobId, refs }));
  report.unmatchedJobs = jobs
    .filter((j) => !matched.has(j.id))
    .map((j) => ({ jobId: j.id, worktreePath: j.worktreePath ?? '' }));
  return report;
}

/** The summed counts of every session recorded on `jobId`; null when none is recorded. */
export function jobTokens(store: Store, jobId: string): TokenCounts | null {
  const rows = usageOfJob(store.db, jobId);
  if (rows.length === 0) return null;
  const t = zero();
  for (const h of rows.flatMap((r) => r.hours)) add(t, h);
  return t;
}
