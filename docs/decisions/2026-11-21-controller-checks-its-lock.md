# The controller checks its own lock before every step

**Decision.** `acquireRunnerLock` returns the release function with an `owned()` method: true
while the generation it took is still the highest in `<data>/runner-lock/`. The controller
(`src/ops/run.ts`) checks it before every write of `runner.json` and every job step (claim,
release, event, transition, CI read, merge, dispatch, launch). Once a higher generation exists it
throws `LostLockError` (exit 1), which no layer turns into a ticket result: the Claude child is
killed and waited for, the heartbeat timer writes nothing, `pollCi` leaves the `orch-runner` lease
in place, and `orch stop` on the interrupted path refuses to discard the session. Generations
only grow and are never removed, so a lost lock stays lost.

**Why.** A controller is judged dead when its heartbeat is older than `HEARTBEAT_STALE_SECONDS`.
A machine that sleeps longer than that wakes with a live controller that looks dead until its next
beat, and a starter in that window takes the next generation. Before this change only starters
looked at the lock, so the first controller carried on beside the second: two Claude sessions on
the queue, which the one-controller rule exists to prevent.

A longer timeout only moves the window: a sleep can always outlast it, and a longer timeout delays
recovery from a controller that really died. Detecting sleep would need a platform-specific
signal and still leave the same window for any long pause (a debugger, a frozen VM). The holder
checking the lock it holds closes the overlap with one cheap directory read, and recovery and
contention between starters stay exactly as they were.

**What remains.** A starter can take the next generation between a check and the write that
follows it, which can include one `gh` call in `reconcileCi` or `mergeJob`; the controller stops
at its next check, so at most one step overlaps.
Closing that gap needs a real mutual-exclusion primitive (an OS file lock or a database lease),
which would be a lock redesign. The recovery worker's PID file uses a similar beat-based staleness
and is not changed here.
