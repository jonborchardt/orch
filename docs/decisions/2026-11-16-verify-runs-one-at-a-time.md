# Verify runs one at a time

**Decision.** `orch verify` takes a machine-wide lock (`verifyLockPath()` in `src/core/paths.ts`:
`verify.lock` in the runtime data directory, so one lock per installation and per `ORCH_HOME`)
around `startRun`..`finishRun`. The lock is a file created exclusively (`wx`) containing the
holder's PID and start time (`src/ops/verify-lock.ts`). A second `orch verify` waits inside its own
one-shot command with a synchronous sleep, tells the CLI once (stderr notice), and renews its
owner's lease before waiting and every five minutes while waiting, never rotating the token. A
lock whose PID is not running, or an unparseable one older than ten seconds, is stale and taken
over. Release is in `finally` and only removes the file while it is still ours.

**Why.** Parallel factory jobs on one machine ran their verification suites at the same time, and
heavy suites under that load fail for reasons that are about the machine, not the code. Running
them in turn keeps the evidence about the code. Waiting must not cost the job its owner, hence the
renewal. A file lock needs no daemon, keeps the CLI one-shot, and works on every platform.

**Limits.** No timeout, ordering, or fairness among waiters, and no per-repository locks. A
reused PID makes a dead holder look alive; delete the lock file by hand. Two waiters judging the
same dead holder stale at the same instant can, rarely, both run.
