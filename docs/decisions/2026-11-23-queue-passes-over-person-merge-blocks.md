# The queue passes over a ticket whose merge only a person can unblock

Superseded by 2026-11-23-queue-ends-only-on-run-wide-outcomes (which outcomes end the run).

**Decision.** When `mergeJob` refuses a completed job's merge with a code only a person can lift
on that one ticket, the controller ends the ticket as `needs-human`, not `blocked`, with the merge
code as the `runner.stopped` code and that person's step as `next`. The codes and their steps are
`personMergeStep` in `src/core/workflow.ts`, the one place `src/ops/run.ts` consults:
`workflow-changed` (Merge on the dashboard), `not-authorized` (Merge on the dashboard, or enable
the opt-in), `head-changed` (remove the unverified commits), `pr-closed` (reopen the PR),
`pr-draft` (mark it ready), and `second-conflict` (resolve it by hand; no third job). Everything
else that follows from `needs-human` is unchanged: the queue passes the ticket over for the
session, the summary lists it, the exit status is 1, and `orch do` ends at its one ticket.

This amends 2026-11-22-queue-passes-over-needs-human for these merge codes only.

**Why.** On ticket 0122 (PR 126, `workflow-changed`) the run ended at "4 of 5 completed" and the
queue sat idle for hours, with a next step (`orch do 0122 tries again`) that would be refused
again. These refusals are about one PR and wait on a person exactly like an escalation, so the
same handling applies, and reusing the outcome avoids a new one threaded through the queue, the
summary, and the CLI. Every other code keeps ending the run: `github-refused`, `merge-no-answer`,
and the controller's own codes are budgets or GitHub and tool failures that may hit every ticket,
and `unverified-merge`, `ticket-open`, `conflict`, `wrong-*`, and the like point to a defect in
the controller's path.
