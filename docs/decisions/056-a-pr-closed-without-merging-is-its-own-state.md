# 56. A PR closed without merging is its own state

`jobs.prState` knew `draft`, `ready`, and `merged`; `prWorkflowState` answered `undefined` for a
closed PR, and `recordCi` skips an undefined state, so a factory PR that a human closed stayed
recorded as `draft` for ever. `closed` is now the fourth value. It is written only from GitHub's
answer (`orch gh pr status`, `orch gh ci`) or by the owner through `orch job pr`; cancelling a
job never implies it, because a cancelled job's PR may well still be open. The pure transition
refuses to complete the `ci` stage, and `resume --to completed` refuses to accept delivery, while
the PR is `closed`: a closed PR is not a deliverable whatever its checks said. Reopening is
observed the same way (the next observation records `draft` or `ready` again). Historical rows and
events are untouched: a job whose PR was closed before this change keeps `draft` until the next
authoritative observation, and the `pr.recorded` / `ci.observed` log is append-only. No migration:
the column is free text typed in TypeScript.
