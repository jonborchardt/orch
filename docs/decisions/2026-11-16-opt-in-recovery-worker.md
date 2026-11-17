# An opt-in recovery worker continues only recoverable jobs

**Decision.** `orch recover run` is a foreground loop of one-shot passes (`recoverPass` in
`src/ops/recover.ts`); `orch recover start` launches it detached with a PID file, and `stop` and
`status` manage it. Each pass first probes GitHub (`gh api rate_limit`); if the probe fails it
touches no job. A job is **recoverable** when its next step is an operation `orch` runs itself,
needs no agent, and is safe to repeat: today only the `ci` stage with a PR recorded and no live
lease (none, released, or lapsed). For each recoverable job the worker runs one short ownership
episode as the fixed session `orch-recovery`: `resumeFactoryJob` (never `force`), `start` when
pending, one `reconcileCi`, release unless that write finished the job. Attempts are logged as
`recovery.attempted` / `recovery.failed` events; five consecutive failures for the same head
escalate the job to `needs-human` (`recovery retries exhausted: <last error>`). Jobs stalled in an
agent stage (`spec` to `pr`) are reported as `needs-session` with the resume command, never
claimed. The classification is a pure function in `src/core/recovery.ts`.

**Why a separate process, not `orch ui`.** The dashboard is optional, user-facing, and serves HTTP;
recovery must be startable on its own (no port, no browser) and stoppable without closing the
board. Keeping it out of `orch ui` also keeps the rule that the dashboard never acts on its own:
every dashboard write is a human click. Both stay exceptions to the one-shot rule, opt-in, and
never required for a job to run.

**Why it never launches sessions.** `docs/session-launch.md` and decision 51 establish that only a
running Claude session in VS Code's Agents window has the host's `create_session` and
`send_message` tools, that `orch` never starts a Claude process, and that the host does not give
`orch` the session UUID. A process outside the host therefore cannot reliably relaunch or
reconnect the session that was driving a job; spawning `claude -p` or `claude --bg` would create a
second, invisible session next to one that may still be open, the duplicate the request forbids.
So agent stages are surfaced, not resumed.

**Why it waits for the lease.** It never forces a takeover (decision 31): a live lease means a
session may still be working. Recovery starts once the previous owner's lease lapses (30 minutes
by default). A ci job released on purpose is also treated as recoverable; releasing in ci already
means "resume later".

**Limits.** Only the `ci` stage is continued automatically. No service registration or start at
login.

**Why the PID file carries a heartbeat.** A PID can be reused after a reboot, crash, or sleep, so a
live process holding the recorded PID is not proof of a worker. The file records `startedAt` and,
after every pass, `beatAt`. It is stale when `startedAt` predates the last boot (`os.uptime()`) or
the heartbeat is older than the longest sleep between passes plus ten minutes
(`HEARTBEAT_STALE_SECONDS`). A stale file is never trusted: `status` reports no worker, `start`
proceeds, and `stop` only removes the file, never signalling its PID. A worker that finds another
worker's PID in the file after a pass (it slept past the heartbeat limit and was replaced) exits.
`run --once` takes no PID file but refuses while a live worker runs, so two `orch-recovery`
episodes never interleave.
