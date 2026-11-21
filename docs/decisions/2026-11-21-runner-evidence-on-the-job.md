# The controller records what it did on the job, and that is all Ticket 5 adds

**Decision.** The foreground controller (`src/ops/run.ts`) writes two informational events to the
job it was working on, through the existing `recordEvent`, as session `orch-runner`:
`runner.session` when a Claude process it started has ended (outcome, exit code, signal, seconds,
whether the job moved), and `runner.stopped` when a ticket ends blocked or waiting for a person
(outcome, a code for what stopped it, the reason, the job's stage and status, the next command).
`runner.stopped` is a reported event, so the status mail carries it. Every way out of `runTicket`
passes one place, which records the stop and releases the job; a job waiting in `needs-human` is
released there too, where it used to keep the runner's lease until it lapsed.

The events are evidence, not state. Nothing reads them to decide anything, no budget is derived
from them, and they change no stage or status. They are written only to a job the controller
holds or nobody holds, never by force, and a failure to write one is logged and changes no
outcome. A stop on request records the ended session and no stop. A repeated stop with the same
code and reason, with nothing on the job since, is not written twice.

**Why.** A ticket the controller gave up for its own reasons (two sessions without progress, CI
still pending, an undecided or refused merge) left a job that looked merely unowned: the reason
was on the terminal and in `runner.json`, which the next session replaces. The job's event log is
where every other reason already lives, and the recovery worker records its attempts the same way.

**What was looked at and left out.** The investigation behind this change found the job-level
recovery complete (one CI re-run per head, `maxCiRepairs`, `maxRounds`, one re-land, a merge
record that survives a crash, resume from any interruption) and covered it with runner-level
tests instead of new code. Three further changes were considered and are not part of this work;
none is an open requirement:

- **A wait before starting a session again after one that exited without progress.** Not shown
  that a usage limit or a network failure makes `claude -p` exit quickly, so the delays would be
  guesses. The rule stays: two such exits in a row stop the ticket, with nothing in between.
- **A wall-clock ceiling on a session.** A long session is not a stalled one, and no hang has
  been observed. Only the process ending ends the wait; `orch stop` is the person's answer.
- **Going on to the next ticket after one that could not be finished.** The queue stops at the
  first such ticket by decision 2026-11-21-foreground-factory-runner; that stands. No skipping,
  no breaker after consecutive failures.

Runner budgets stay in memory: `orch do` or `orch resume` starts them again, and each takes a
person. Durable counters, a retry policy, a watchdog, re-attaching to a surviving child, and
choices answered in the dashboard (ticket 0057) are likewise not built.
