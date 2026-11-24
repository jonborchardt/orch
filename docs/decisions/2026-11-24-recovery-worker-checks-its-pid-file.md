# The recovery worker checks its PID file before every pass and episode

**Decision.** `holdPidFile` returns a read-only `owned()` (true while the PID file still names
this process), and `orch recover run` passes it to `runWorker`. The worker checks it at the top of
every loop iteration (before the first pass and after every sleep), and again after each pass
before mail, the status file, the log line and the heartbeat. `recoverPass` checks it before each
job's episode and starts no more once it is false. On a loss the worker returns, without
recording it, `{ online: false, probeError: 'superseded: another recovery worker holds the PID
file', jobs: [], nextSeconds: null }` and writes nothing more: no episode, no mail, no status
file, no log line, no PID write. This is decision 2026-11-21-controller-checks-its-lock moved to
the recovery worker.

**Why.** A worker that slept past `HEARTBEAT_STALE_SECONDS` (a long machine sleep) has a stale PID
file, so a second `orch recover start` or `run` takes it. Before this, the first worker asked
`beat()` only after a pass, so on waking it ran one more full pass first: GitHub probes, an
`orch-recovery` episode per recoverable `ci` job, mail, and an overwrite of the new worker's
status file (ticket 0111). Leases kept job state safe; the cost was duplicate GitHub reads and
confusing events. The check runs before a step, not around it, so one step already started (a
`gh` call inside `reconcileCi`) may still overlap, as 0096 accepts. Mail for events of a pass cut
short is left to the new worker's watermark. Replacing the PID file with a generation lock, which
would also close `beat()`'s read-then-write gap, is left for a later ticket.
