# The queue passes over a ticket that needs a person

**Decision.** In queue mode (`orch start`, `orch start repo`, and `orch resume` of a queue
session), a ticket whose job ends in `needs-human` no longer ends the run. `runTicket` releases
the job and writes `runner.stopped` (`code: needs-human`) as before; `runQueue` then adds the
ticket to the session's passed-over set and takes the next ready ticket. The ticket stays passed
over for the rest of the session, `orch resume` included (the set is rebuilt from
`session.results`), even if a person decides it meanwhile; a new session picks it up again. The
`needs-human` result stays in `session.results` and the end-of-session summary, with its job, its
reason, and its next step; it is not copied into `session.skipped`, which means "never
attempted". The exit status stays 1. `orch do` still ends at its one ticket, and `blocked`,
`refused`, and `stopped` still end the queue.

This amends the "queue stops at the first ticket it could not finish" clause of
2026-11-21-foreground-factory-runner for `needs-human` only.

**Why.** An unattended queue halted on the first job waiting for a decision, so one ticket idled
everything behind it. The reason for stopping, that later tickets may depend on the failed one,
does not need the stop: a dependency counts only when it is `done` (`blockReasons` in
`core/tickets.ts`), so every ticket that depends on the escalated one is still not ready and is
held back. Nothing is hidden: the decision waits durably on the job, the summary lists it, and
the exit status signals it. `blocked` and `refused` keep ending the run, because they mean a
budget, a refusal, or a defect in the controller's path that may hit the next ticket too.
