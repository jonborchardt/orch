# 47. Dashboard status is derived, explained from structured fields, and actions come from the server

`liveness` used to fold `completed` and `cancelled` into one green `finished`, and the only
explanation for a stopped job lived in the detail view's plan. The dashboard now derives one
execution state per job (`src/server/status.ts`), separate from the workflow stage, and a
`blocker` built only from persisted fields: the newest `job.blocked` / `stage.failed` /
`job.interrupted` / `job.cancelled` event (its `from`, `reason`, and actor), the `decision.md`
marker, the consolidation's BLOCKING count, and the newest verification run. The recorded reason is
shown verbatim and never parsed; the code-generated `max review rounds reached` reason is the only
string compared. An escalation the state cannot classify is labelled exactly that. Parsing prose,
and inferring duplicate jobs from matching titles, were rejected: both would be guesses shown as
facts. The detail API also lists the actions the workflow allows in the current state
(`allowedActions` in `ops/actions.ts`), which supersedes the client-side copy of those rules noted
in §44; the server still validates every POST. The resume affordance is a copied
`/factory resume <id>` plus the checkout to run it in: nothing on the server starts or wakes a
session, and copying mutates nothing. The command is withheld while any session holds a live
lease (the holder is named instead), because `orch factory resume` would be refused without a
deliberate `--force`; the dashboard never takes ownership by itself. Among the controls, only two
blockers promote an action: an approver escalation promotes Approve, and exhausted review rounds
promote Request rework, since that is the transition the workflow itself would make. Every other
blocker gets neutral controls rather than a guessed recommendation.
