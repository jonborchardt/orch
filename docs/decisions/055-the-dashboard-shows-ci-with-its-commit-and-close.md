# 55. The dashboard shows CI with its commit, and close-out is the transition's own rule (Phase 2, C03)

**Found.** The board and detail showed `jobs.ciStatus` alone, so a rollup could read as current
after the PR head moved, a ci-stage escalation was an unclassified `Escalated from ci`, the repair
budget and failure logs that `orch gh ci` records were invisible, a job completed by `resume --to
completed` looked like a passing build, and the only human close-out lived in the CLI.

**Decision.** One read model, `ciView` (`src/server/status.ts`), built from persisted fields: the
rollup columns (`ciStatus`, `ciHead`, `ciCheckedAt`, `ciRepairs`, `maxCiRepairs`), the newest
`ci.observed` event (an `orch gh ci` reconciliation carries `outcome`, `reason`, and `failures`; a
`pr status` observation does not and contributes nothing), and the `job.completed` event
(`acceptedByHuman`, or a `head` for GitHub's verdict, or neither for jobs older than the ci stage).
The verdict is shown with its SHA; the detail compares it to the worktree HEAD and marks a stale one,
the board does not inspect worktrees and says so with `current: null`. A ci escalation is its own
blocker kind, classified from the reason code (`max CI repair cycles reached`) and the last
outcome, never from prose. Close-out: `cannotAcceptDelivery` is extracted from the pure transition
and used both by `acceptDelivery` and by `allowedActions`, so the dashboard offers Accept delivery
exactly where `resume --to completed` would succeed; the action requires a reason, is never
primary, and the result is labelled a human close-out everywhere. No schema change: every field
was already persisted (decision #48 made sure the SHA binding and the budget were columns).

**Rejected.** A `closed`/`merged-by-hand` status column (the newest observation already records
it); reimplementing the gate in React (the client renders the server's list and only decides
prominence); promoting Request rework for CI infrastructure failures (not a code defect); any
automatic merge or ready-for-review action.
