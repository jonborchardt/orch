# The dashboard sums token usage from Claude Code transcripts, on demand

**Decision.** Partly supersedes decision 61. The dashboard's Usage section (`GET /api/usage`,
`src/server/token-usage.ts`) parses the `usage` object of assistant records in each job's Claude
Code transcripts (main session and `subagents/agent-<id>.jsonl`) and sums input, output, cache
read, and cache creation tokens per UTC hour and per job, for the last 24 hours, 7 days, or 30
days. It runs on each request: no table, no migration, no cache, nothing written. Files are found
by the Session tab's discovery (`discoverSession`) and read only through `readConfined`, whole,
within a per-file cap, a per-request byte budget, and a subagent-file cap. `orch job usage` keeps
`tokens.measured: false`; its reason points at the dashboard. Decision 61 stands for the CLI and
for cost: no price table, no per-model or per-role split.

**Why.** The request asked for a graph of tokens per hour, and the transcripts are the only place
the counts exist on this machine. Reading on demand keeps the database the record of workflow
state only and needs no schema change.

**Known limits.**

- The transcript format is Claude Code's and undocumented. Unknown shapes are skipped, so counts
  can be under-reported silently if the format changes.
- Lines sharing a `message.id` (split content blocks) are counted once: the last kept line in the
  fixed read order (jobs by id, sessions oldest attach first, main file then subagents by name,
  lines in order). This assumes repeated lines carry the same or growing usage.
- A job with an unreadable or over-cap source flags every hour of its span as missing, from its
  first attach to now or to `max(updatedAt, completedAt)`. That over-approximates: idle hours are
  flagged too, because the hours that really had usage cannot be known without the file.
- A job whose span misses the range is not read, so a deleted transcript there is not reported;
  hours outside its span cannot be affected.
- A session attached to two jobs counts once in the range total; its tokens go to the job the read
  order reaches last.
- Hours are UTC buckets labelled in local time, so non-whole-hour time zones see half-hour labels.
- Cost: whole-file reads of many large transcripts on each request. If too slow, the next step is a
  process-memory cache keyed by path, size, and mtime, and only after that a table.
