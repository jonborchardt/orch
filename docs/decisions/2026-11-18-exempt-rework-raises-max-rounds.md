# Exempt rework rounds raise maxRounds instead of using it up

**Decision.** `transition` (`src/core/workflow.ts`) raises the job's persisted `maxRounds` by one
at every transition that opens a round not caused by review findings, and records the new value as
`maxRounds` on the event: `rework` from `pr` (base integration, `job.reworked`), `rework` from `ci`
with repairs left (CI repair, `job.reworked`), and `resume` from `needs-human` to `build`,
`simplify`, or `review` (`job.resumed`; the dashboard's Request rework and Request review round are
escalate + resume). A rejected review escalates with `max review rounds reached` when
`round >= maxRounds`. `rejectedBefore` is removed; this supersedes its sentence in
`2026-11-16-re-review-opens-a-new-round.md`.

**Why.** `maxRounds` limited rejected rounds while `round` counted every build, so the board showed
figures such as round 5 of 3 (job-5b83c45c) and the limit was neither enforced visibly nor
explained. With every non-review cause raising the maximum, the plain round comparison is the
budget, `round <= maxRounds` holds, and each raise is in the job's history. CI repair stays exempt
because `maxCiRepairs` already bounds it. A human resume is the authorization for a round past the
automatic limit; recording it makes the indicator truthful and grants one round per resume.

**Limits.** Jobs in flight that already had a CI repair, base rework, or human resume were not
backfilled and may escalate earlier; a human resume grants the round. A human resume grants a round
even when the job was escalated within budget (a clamp was rejected as harder to explain).
`maxRounds` can grow past the 1 to 10 range `factory.json` accepts.
