# The queue ends only on run-wide outcomes; every ticket-specific one is passed over

**Decision.** In queue mode (`orch start`, `orch start repo`, `orch resume`) a ticket that ends
in anything but `done` or `stopped` is reported with its next step, recorded as `runner.stopped`
on its job, passed over for the rest of the session (across `orch resume` too), and the
controller takes the next ready ticket. Only an outcome that would hit every ticket ends the run.
Those are named once, as stop codes, in `RUN_ENDING_CODES` with the predicate `endsRun` in
`src/core/workflow.ts`, which `runQueue` and the resumed-ticket check in `drive`
(`src/ops/run.ts`) both decide through:

- `claude-failed`: claude cannot start;
- `github-unreadable`, `merge-no-answer`: GitHub cannot be read or gives no answer;
- `github-refused`: the `gh pr merge` call itself failed.

A stop request and a lost lock end the run by structure and are not ticket codes. Any other
code, including one added later, continues the queue; a result without a code (a `runner.json`
written before `TicketResult.code`) counts as ticket-specific. For `ticket-open` (merged and
verified, a box left unchecked) the next step is to tick or move the remaining boxes, then
`orch ticket done <id>`, never `orch do <id> tries again`. `orch do` still ends at its one
ticket, exit status is still 1 when any ticket ended blocked, refused, or waiting for a person,
and the `needs-human` outcome for merge codes only a person can lift (`personMergeStep`) is
unchanged.

This supersedes 2026-11-23-queue-passes-over-person-merge-blocks on which outcomes end the run,
and extends 2026-11-22-queue-passes-over-needs-human to every ticket-specific outcome.

**Why.** Each earlier fix listed one more outcome to pass over, and everything unlisted kept
ending the run: `orch start` stopped early on a single ticket four times in two days (0106 and
0115, 0116 and 0118, 0122, 0113), the last on `ticket-open` with a next step that could not help
because the job was already merged. Naming the few run-wide outcomes instead of the many
ticket-specific ones makes continuing the default. The cost, accepted: a systematic controller
defect behind `unverified-merge`, `conflict`, or `wrong-*` now blocks tickets one by one instead
of once, each still reported and counted in the exit status; and `no-progress` may spend two
sessions per ticket in a broken environment, while `claude-failed` still ends the run when
claude cannot start at all. `github-refused` can be a per-PR refusal, but is kept run-ending as a
GitHub or tool failure.
