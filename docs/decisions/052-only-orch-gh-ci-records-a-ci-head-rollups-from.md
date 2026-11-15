# 52. Only `orch gh ci` records a CI head; rollups from `pr create` and `pr status` carry none

**Observed (Phase 1 validation, scenario A06).** A coordinator was killed while CI was pending; its
orphaned shell still ran `orch gh ci`, which recorded `passing` for the head. The session that
resumed after the lease lapsed received the plan "Required checks passed for <sha>. Complete the
job." and completed without reading GitHub again. That completion rested on a genuine per-commit
verdict, but the same two columns (`ciStatus`, `ciHead`) were also written by `orch gh pr create`
and `orch gh pr status --token` from the `gh pr view` rollup, where "no failing and no pending
check" reads as `passing` even when every check was skipped. A job could therefore complete `ci`
on a rollup, never having run the per-commit evaluation that decision 48 made the only source of
truth (every reported check required, skipped-only is not a pass, grace window, SHA binding).

**Decision.** `ciHead` is written only by `orch gh ci`. `pr create` and `pr status --token` still
record the rollup (`ciStatus`, `ci.observed` event) for the dashboard, but with `head: null`, so
the pure transition (`no CI verdict has been read for the PR head`), the Git-aware gate
(`ciHead` must equal HEAD), and the plan (`ci.current`) all require a fresh `orch gh ci` before
`complete`. Rejected: a schema change to record the source of each observation (the head column
already distinguishes them once only one writer sets it). Decision 53 then removed the remaining
case in which a stored verdict completed the stage.
