/** `orch usage backfill`: record finished jobs' token usage from their transcripts (ops/token-usage.ts). */
import { UsageError } from '../core/errors.ts';
import { backfillUsage, type BackfillReport } from '../ops/token-usage.ts';
import type { Store } from '../storage/client.ts';

export const USAGE_HELP = `Usage: orch usage backfill [--json]

  backfill   Record the token usage of every finished job's sessions that are not recorded yet,
             from the transcripts under <Claude home>/projects/. A transcript belongs to a job
             only when its cwd is the job's worktree path. Reports what it recorded, jobs with no
             matching transcript, matches of unfinished jobs (a later run records them),
             transcripts under the orch worktrees root that match no job, and files it skipped.
             Recorded counts are never rewritten. The counts are for display only.
`;

export function formatBackfill(r: BackfillReport): string {
  const n = r.recorded.reduce((t, j) => t + j.refs.length, 0);
  const section = (title: string, lines: string[]) =>
    lines.length ? [`${title} (${String(lines.length)}):`, ...lines.map((l) => `  ${l}`)] : [];
  return [
    `Recorded ${String(n)} session(s) on ${String(r.recorded.length)} job(s).`,
    ...section(
      'Recorded',
      r.recorded.map((j) => `${j.jobId}: ${j.refs.join(', ')}`),
    ),
    ...section(
      'Jobs with no matching transcript',
      r.unmatchedJobs.map((j) => `${j.jobId}: ${j.worktreePath}`),
    ),
    ...section(
      'Not recorded, job unfinished',
      r.unfinished.map((u) => `${u.jobId}: ${u.ref} (${u.status})`),
    ),
    ...section(
      'Transcripts under the worktrees root matching no job',
      r.orphans.map((o) => `${o.ref}: ${o.cwd}`),
    ),
    ...section(
      'Skipped files',
      r.skipped.map((s) => `${s.file}: ${s.reason}`),
    ),
  ].join('\n');
}

export function runUsage(store: Store, args: string[]): BackfillReport {
  if (args[0] !== 'backfill' || args.length !== 1) {
    throw new UsageError(`Unknown or missing usage command\n\n${USAGE_HELP}`);
  }
  return backfillUsage(store);
}
