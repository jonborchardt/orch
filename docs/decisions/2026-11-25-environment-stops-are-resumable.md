# A rebuilt orch or a bad factory.json ends the run, resumably

**Decision.** Two environment problems are run-wide stop codes in `RUN_ENDING_CODES`, handled like
`usage-limit` (decision 2026-11-24-usage-limit-ends-run-resumably): the session stays unfinished
with its ticket and job in flight, the `runner.stopped` event's `next` is `orch resume`, and the
ticket is never passed over for it.

- `orch-rebuilt`: the controller reads the installed build's identity once when it starts
  (`buildStamp` in `src/ops/install-build.ts`: the commit in `dist/build-info.json` plus that
  file's modification time, so a rebuild from the same commit counts) and compares it before each
  ticket and before each Claude child launch. A change stops the session with "orch was rebuilt
  since this controller started; run orch resume". No stamp at start turns the check off.
- `bad-config`: `loadConfig` is called at the same checkpoints, and when `runTicket` catches an
  `OrchError` (or dispatch is refused) while `factory.json` fails validation, the result is
  `bad-config` with the validation message instead of `error` or `refused`.

A stop before a ticket creates no job and records no result; `orch resume` then takes a stranded
in-progress ticket first, as a fresh `orch start` does.

**Why.** A controller is a long-lived process running the code it loaded. After a rebuild that
changed the config format, an old controller rejected the new `factory.json`, recorded the ticket
it was on as passed over with `error` while its job sat healthy in `ci`, and `orch resume` skipped
it for the rest of the session (ticket 0172). Neither cause belongs to a ticket. Reloading or
re-executing the controller was left out: stopping is simple and costs one `orch resume`. A
`touch` or copy of the stamp also reads as a rebuild; that is accepted.
