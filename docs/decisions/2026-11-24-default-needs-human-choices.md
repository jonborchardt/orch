# Every needs-human job offers a continuing choice, and the queue takes a decided escalation again

**Decision.** Every `job.blocked` event the pure `transition` writes records `choices` (ticket
0132): session and gate escalations (`orch gh ci`, recovery), the review round limit, a repeated
scope gap, and the CI repair limit. `defaultChoices` in `src/core/workflow.ts` derives them from
the job's mode and return stage and the block reason: a stage the reason names (`resume --to
<stage>`, `resume to <stage>`, `resumes --to <stage>`, any case; `completed` maps to Accept
delivery) first, then the return stage, then the buttons a known reason implies (Retry review for
the round limit, Accept policy for a reason naming the verification policy), and Cancel last. A
fast job never gets a stage outside its resume targets. Recorded `--choice` values are kept as
given when one continues the job (`resume`, `rework`, `review`, the new `accept-policy`);
otherwise the default primary goes in front (`withDefaultChoice`). `currentChoices` applies the
same rule to an older `job.blocked` that recorded none, so no needs-human job shows only the
generic actions. The dashboard styles the first choice as the primary button.

In queue mode the controller takes a ticket it passed over as an escalation (`needs-human` result
with code `needs-human`) again in the same session, `orch resume` included, once its job is out of
`needs-human`, not cancelled, and not held by a live lease. The check runs before each next ready
ticket, so also right before the session would end. A `needs-human` result with a
`personMergeStep` code is not taken again: Merge on the dashboard completes the ticket by itself,
and the other codes need work outside orch. A retaken ticket that escalates again is passed over
again. The job detail's after-action line (`controllerContinues` in `src/ops/runner-state.ts`)
says "the controller continues it" only when that retake will happen; otherwise it names
`orch do <ticket>`.

This amends 2026-11-22-queue-passes-over-needs-human: a passed-over escalation no longer stays
passed over for the rest of the session once a person decides it. Everything else there holds.

**Why.** Choices appeared only when a session remembered `--choice`, so most escalations left the
person on the CLI. Parsing the stage out of the reason is a heuristic, but it only picks among
existing actions, each with its own refusals, and never overrides a recorded choice that
continues the job. Taking a decided ticket again in the same session is the smallest change that
makes a dashboard click continue the work without a new command; a new session still takes only
open tickets, and a controller that waits for a decision once nothing is ready stays out of scope.
