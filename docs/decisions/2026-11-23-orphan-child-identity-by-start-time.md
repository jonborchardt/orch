# An orphaned Claude child is told from a reused PID by its start time

**Decision.** When the controller dies, `orch resume` and `orch stop` decide whether the Claude
child it recorded is still running with `childIdentity` (`src/ops/runner-state.ts`). It reads the
OS start time of the live process at the recorded PID (`processStartMs` in `src/core/exec.ts`:
`Win32_Process.CreationDate` for that PID on Windows, `ps -o lstart=` with `LC_ALL=C` elsewhere)
and compares it with the recorded `startedAt`, which `launchClaude` takes just before the spawn.
Within 10 s before (`START_SLACK_BEFORE_MS`: `ps` reports whole seconds and the OS process clock
can differ a little from `Date.now()`) to 60 s after (`START_SLACK_AFTER_MS`: a delayed spawn on a
loaded machine) it is the original child and both refuse. Outside it the PID was reused, and both
go ahead without `--force`. A lookup that cannot answer (unsupported, error, timeout, unparseable)
is unknown and refuses, as before. `--force` still overrides every refusal. Nothing signals,
kills, waits for, or adopts the process.

The refusal names the PID, the recorded start, whether identity was confirmed or unknown, a
platform inspect command, and the procedure: end it yourself if it is Claude and rerun, `--force`
only if it is another program.

`runnerStatus` (`orch status`, `GET /api/runner`) keeps the cheap PID-and-boot check: the dashboard
polls it and the Windows query can take seconds.

**Rationale.** The PID alone made every reused PID block recovery until `--force`, which trains a
person to force. Start time is available on every supported platform without new dependencies and
needs nothing recorded at launch beyond `startedAt`. Every failure errs toward refusing, so the
one-agent-per-job guarantee holds. The window can still be wrong: a clock change (NTP, manual)
between launch and check, or a spawn delayed past 60 s, would class the live child as reused; a
PID reused inside the window would be refused. The window is generous to make the first unlikely.
Refusing even `--force` on a confirmed original was not chosen: it changes `--force` and could trap
a person after a false match.
