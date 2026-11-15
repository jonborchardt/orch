# 57. Supersession is a column on the old job, recorded explicitly

The board showed several jobs with the same title (a cancelled attempt and its restart) with no
way to tell which replaced which; the only trace was free text in a cancel reason. `jobs.supersededBy`
now names the replacement, written by `orch job supersede <old> --by <new>`, never inferred. A
column rather than an event-only record because the relationship is state the board and `orch job
show` query (decision 15: events are an audit log, columns hold state); the `job.superseded` event
keeps the history of changed replacements. The rule set is deliberately small: same repository, no
self-reference, no loop, nothing deleted or merged, no generalized dependency graph. The command is
a short ownership episode (decision 33), shared with the dashboard actions through `withLease`, so
a cancelled or abandoned job needs no manual claim and a live session's lease is still respected.
Rows created before the migration carry null and are never back-filled.
