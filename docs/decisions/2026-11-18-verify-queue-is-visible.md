# The verify queue is visible

**Decision.** The verify lock (decision 2026-11-16-verify-runs-one-at-a-time) also records the
holder's job id, and a waiting `orch verify` writes a queue entry `<job>.<pid>.json` (pid, job,
since) under `verifyQueueDir()` (`verify-queue/` in the runtime data directory). The entry is
removed once the lock is taken and in `finally` on every other exit. `verifyQueueState` in
`src/ops/verify-lock.ts` reads both, ignoring dead PIDs, and `verificationStatus` exposes it as
`queue` (`running`, `queued` with holder job, since, and live waiters ahead, or `null`), so
`orch verify show`, `plan.verification`, and the dashboard's Verification tab all show it.

**Why.** Runs were already serialized, but a waiter was visible only on its own stderr: nobody
could tell a queued job from a stuck one, or which job it waited for. Files next to the lock keep
the CLI one-shot and need no schema change or new run status.

**Limits.** The queue is not FIFO; "ahead" is a hint. The state is read-only and never affects
`valid` or `reason`, so gate decisions are unchanged. A reused PID can keep a dead waiter looking
queued; delete its entry by hand. Lock files without a job id still work and report the holder
job as unknown.
