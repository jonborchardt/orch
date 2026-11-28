# The controller waits for a checkout that is slow to answer Git, then dispatches the same ticket

Ticket 0214. Extends [2026-11-26-controller-waits-for-limits](2026-11-26-controller-waits-for-limits.md)
with a third bounded wait.

**Decision.** Dispatching a ticket (`ticketJobRequest` in `src/ops/tickets.ts`) asks Git about the
ticket's recorded checkout with its own budget, `DISPATCH_REPO_CHECK_BUDGET_MS` (30 seconds), and
neither reads nor writes the timeout memo of the polled list. A lookup that still times out throws
`CheckoutTimeoutError`, distinct from the `ValidationError` of a missing checkout ("not available
here") or a wrong target ("another repository"). Nothing is created in any of the three.

The factory controller (`runTicket` in `src/ops/run.ts`) treats that error as the machine's state,
not the ticket's: it keeps the same ticket, waits inside its foreground command, and dispatches
again. `CHECKOUT_WAITS`: 15, 30, 60, then every 120 seconds, at most 30 minutes of waiting in a
row. Past the bound the run stops resumably with `checkout-timeout` (in `RUN_ENDING_CODES` and
`RESUMABLE_CODES`): the session stays unfinished with the ticket in flight, never passed over, and
`orch resume` takes it again. No job exists yet, so there is no `runner.stopped` event; the code is
on the summary and the session record.

The wait is the limit wait's mechanism (`waitOut`): the session file carries
`wait: { reason, until }`, shown by `orch status`, `/api/runner`, and the dashboard; `orch stop`,
`orch stop next`, and Ctrl+C end it as `stopped`. After each wait the rebuilt-orch and bad-config
check (`run.environment()`) runs before any new dispatch.

The dashboard's polled list (`views()`, `listTickets`) is unchanged: 2 seconds per read shared by
all checkouts, a 60-second memo of timeouts, and a timed-out checkout blocks its tickets, never
readies them. So is the controller's own ready read in `runQueue`; a ticket it misses is simply not
ready on that pass.

**Why.** Right after a merge, removing the worktree keeps the disk busy, and
`git rev-parse --git-common-dir` in the primary checkout can take longer than 2 seconds. With the
list's budget the dispatch failed, the ticket was passed over as `refused`, nothing else was
ready, and an unattended run ended on a condition that clears by itself in seconds. A dispatch is
one-shot, not polled, so it can afford 30 seconds; the wait covers the rest. The 30-minute cap
keeps a truly hung disk from holding the terminal indefinitely, and the stop stays resumable.
Manual dispatch (`src/ops/factory.ts`) gets the same 30-second budget and the typed error, but no
retry: a one-shot command reports and exits. Like the other two waits, this exists only while the
controller's command runs: no daemon, timer, detached process, table, or job event.
