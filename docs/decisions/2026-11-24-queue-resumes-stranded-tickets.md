# The queue resumes stranded in-progress tickets before ready ones

**Decision.** Between tickets, `runQueue` in `src/ops/run.ts` first looks at the in-progress
tickets in its scope, ranked by `orderTickets` as if open, and takes the first one not passed
over this session whose active job is `pending` or `running`, not in `needs-human` or
`completed`, and unowned or past its lease (`stranded`, read from the job row, never from
`runner.*` events). It continues that job through `runTicket`, the way `orch do` does. Only when
there is none does it read the ready view. The merge opt-in check and the passed-over set apply
to both picks, so a stranded ticket that ends again without finishing is passed over once and not
tried again in the session, across `orch resume` too. How the ticket was taken is
`RunnerSession.pick` (`resume` or `ready`), shown by `orch status` and written on the
`runner.session` and `runner.stopped` events; `orch do` writes none.

**Why.** An in-progress ticket is never ready, so a job a person sent back with
`orch factory resume <job> --to build --release` sat unowned until someone ran `orch do`
(ticket 0133). Resuming first finishes started work before starting more. Jobs held by a live
owner, waiting for a person, blocked, or completed (merged with the ticket left open) are left
alone: each needs a person or is someone else's. A job left `running` with an expired lease is
taken over, which is what an expired lease means.
