# A scope gap at approval reworks automatically, once

**Decision.** `decision.md` has two more outcomes besides `APPROVE` and `ESCALATE`:
`REWORK-BUILD` (the code is less than the spec) and `REWORK-SPEC` (the spec is less than the
request). `rework` from `approve` without base integration is allowed only on one of them and sends
the job to `build` or `spec` (`core/workflow.ts`), raising `maxRounds` like the other reworks that
are not review-driven and counting on the new `jobs.scopeReworks` column. With one scope rework
already taken, the next `REWORK-*` moves the job to `needs-human` with reason
`SCOPE_GAP_REASON`, `returnStage` the requested stage. `decision.md` records the hash of the
`spec.md` registered with it; after `REWORK-SPEC`, `complete` from `spec` is refused until
`spec.md` changed, and the existing challenge gate then needs a PASS for the new spec. A human `resume` out of a spec escalation to a later stage is
refused the same way while `spec.md` still has that hash; a resume does not override it. Reviewer
prose makes any in-scope item the diff does not implement BLOCKING, so review sends it back to
build as before; the spec challenger answers CHANGES to a spec that drops part of the request
unless the request or a human excluded it.

**Why.** Job job-a00ab255 (todo 0055) had a spec that cut two requested cases; the challenger
passed it and the approver could only escalate, so every queued todo behind it waited for a human
reply. Missing scope is work to do, not a decision to make. The target is a marker in the
registered artifact so code, not prose, decides where the job goes.

**Limits.** Code cannot tell whether a second gap is "the same" one, so the bound is a count: one
automatic scope rework per job, and a different gap found afterwards also escalates. A human
resume does not reset the count. The limit is fixed, not configurable. Whether something is a gap
remains the agents' judgement; code enforces only that a CHANGES verdict or a BLOCKING count sends
the round back, that the spec needs a PASS, and that a REWORK-SPEC changes the spec. A human
instruction to drop scope has no recorded field, so the challenger relies on the request text or
the escalation reason.
