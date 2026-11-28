# Per-role tokens are attributed at record time by agentType

**Decision.** Ticket 0083. When `recordSession` (`src/ops/token-usage.ts`) records a session it
also stores a per-agent split in the nullable `token_usage.agents` column: each subagent file's
tokens under the `ROLES` name whose `agent` equals the `agentType` in its `agent-<id>.meta.json`
(read through `readMeta`, confined to the session's `subagents/` directory, at most
`META_MAX_BYTES`), the main transcript's under `coordinator`, and the rest under `other`. The split
is taken over the same de-duplicated records the hourly counts sum, so it adds up to them. The
Agents tab sums the column; it never reads a transcript.

Rows recorded before the column existed keep it null and are never rewritten or backfilled. They
count as unattributed, not as zero, and the Agents tab says how many sessions are attributed.

**Why.** The meta file's `agentType` is the only record of which agent a subagent transcript
belongs to, and transcripts are pruned by Claude Code, so the attribution has to be taken while
the files are read once anyway, at record time. Reading transcripts again on every Agents load was
rejected for the same reason the Usage tab stopped doing so (decision
[2026-11-24-recorded-token-usage](2026-11-24-recorded-token-usage.md)). Rewriting old rows would
need transcripts that may be gone and would break "rows are never rewritten".

**Known limits.** Early figures are thin until new sessions are recorded. An `agentType` of a role
later renamed or removed stays under `other` for good. A bad or missing meta file lands under
`other`; it never stops a session being recorded.
