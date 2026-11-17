# Re-review from needs-human opens a new round

**Decision.** `transition` (`src/core/workflow.ts`) treats `resume` from `needs-human` into
`review` like completing `build`: it sets `round` to `round + 1`. This covers the dashboard's
"Request review round" (`escalate` + `resume --to review`) and `orch job transition resume --to
review`, including the default return of a job escalated mid-review. A plain `resume` of an
interrupted or failed `review` stage keeps its round. The board's Reviews cell and blocking chip
read the current round only; the detail Reviews tab labels that round `(current)` and lists every
earlier round as history.

**Why.** Reviews are stored per `(jobId, round, reviewer)` and re-recording upserts. Re-reviewing
in the same round showed the previous pass's verdicts as the new round's results until each
reviewer re-recorded, then overwrote them, losing history. A new round keeps the old verdicts
intact without a schema change. The board's previous-round blocking fallback made a job whose
rework was under review look blocked, so it was removed; the findings stay in the Findings tab.

**Limits.** A session resumed after an escalation mid-review re-runs every reviewer in the new
round instead of reusing partial verdicts. `rejectedBefore` counts the extra round only if it
rejected, so a passing re-review spends nothing from `maxRounds`.
