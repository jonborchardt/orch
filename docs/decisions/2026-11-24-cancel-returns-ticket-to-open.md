# Cancelling a job returns its ticket to open

Supersedes the "a cancelled one is never replaced" clauses of
2026-11-21-foreground-factory-runner and 2026-11-23-manual-and-autonomous-ticket-runs.

**Decision.** `transitionJob(..., 'cancel')` in `src/storage/jobs.ts`, which every cancel goes
through (`orch job transition <id> cancel`, `orch factory cancel`, the dashboard's Cancel), calls
`releaseTicketForCancel` in `src/storage/tickets.ts` inside the same immediate transaction. When
the job has a ticket that is still `in-progress` and no other unfinished job works on it, the
ticket goes back to `open` with one `ticket.reopened` event (`from`, `to`, `job`, and a note
naming the job and the cancel reason), written by the cancelling session. Any other ticket is
left exactly as it is. Within one `orch start` session a ticket whose job was cancelled is still
passed over; a later session, or `orch do`, gives it a new job.

**Why.** A cancelled job left its ticket `in-progress` with no job (ticket 0137, seen on 0134):
the dashboard showed it as current, and the controller never picked it up until someone ran
`orch ticket reopen`. Releasing the claim where the job ends keeps the ticket's status true to
what is running. The cost is that cancelling no longer parks a ticket: `orch ticket drop` stops
the work for good. Tickets stranded before this change still need `orch ticket reopen`, and the
controller's "in-progress, last job cancelled" branch stays for them.
