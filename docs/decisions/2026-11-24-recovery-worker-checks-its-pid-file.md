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

**Why.** A worker that slept past `HEARTBEAT_STALE_SECONDS` loses its PID file to a second
worker, and before this it ran one more full pass on waking (GitHub probes, episodes, mail, an
overwritten status file; ticket 0111). The check runs before a step, not around it, so a `gh`
call already started may still overlap; a generation lock is left for a later ticket.
