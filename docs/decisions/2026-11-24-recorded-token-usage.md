# Token usage is recorded once per session and summed from SQLite

**Decision.** Partly supersedes 2026-11-24-dashboard-token-usage-from-transcripts. A Claude Code
session's token counts (input, output, cache read, cache creation per UTC hour) are parsed once
from its whole transcript (main file and every `subagents/agent-<id>.jsonl`) and stored in the
`token_usage` table, one row per session ref, on its job. `src/ops/token-usage.ts` is the only
caller of `src/storage/usage.ts`. A session is recorded:

- when the factory controller's child exits (`runJob` in `src/ops/run.ts`), whatever the job's
  state; a failure is logged and changes nothing about the run;
- when the Usage read model reads a session of a completed or cancelled job live; the GET's only
  write, to this table only, and a failure never fails the request;
- by `orch usage backfill`, for finished jobs only, matching a transcript to a job only when the
  `cwd` of its first record that has one is, by `canonicalPath`, the job's worktree path. It
  reports jobs with no match, matches of unfinished jobs, transcripts under the worktrees root that
  match no job, and files it skipped. Nothing else assigns a transcript.

A session with any file missing, refused, over a `USAGE_LIMITS` cap, or unreadable is not recorded
and stays live-read and flagged as before. `GET /api/usage` sums stored rows by their own hours
and reads live only unrecorded sessions of jobs whose span overlaps the range. Rows are never
rewritten or deleted. The counts are display evidence; nothing decides from them.

**Why.** Re-reading every transcript on every Usage load was slow and lost history once Claude
Code pruned old transcripts. Keying by session ref keeps "a session counts once".

**Known limits.**

- Recording while Claude Code still appends (subagents still flushing after a child exits, or an
  interactive session left open on a finished job) under-counts permanently, since rows are never
  rewritten. Accepted as a display-only error.
- Ended interactive sessions of unfinished jobs are read live until the job finishes: they give no
  end signal, and guessing from mtime could record a paused session short.
- Message-id dedup is per session for stored rows; it was global across sessions before, which only
  mattered for a session attached to two jobs, still counted once by its ref.
