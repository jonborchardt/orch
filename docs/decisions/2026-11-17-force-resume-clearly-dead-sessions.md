# The factory skill force-resumes clearly dead sessions

**Decision.** When the session owning a job has clearly died, the `/factory` skill resumes the job
with `orch factory resume <id> --session <s> --force` straight away instead of waiting out the
lease. "Clearly died" means evidence the coordinator saw: the process, background task, or
`create_session` child exited; the run was stopped or killed; or its log shows the API or network
was lost (for example `ENOTFOUND`). Without such evidence, while the lease is live, it does not
force: it reports the holder and expiry and waits or stops with the resume command. The final
report names the evidence whenever `--force` was used. This is a skill rule; `orch` gains no
command, flag, or liveness probe.

**Why the rule lives in prose.** The evidence lives in the harness, not in `orch`: `orch` never
starts or observes a Claude process (decision 51, `docs/session-launch.md`), and its only liveness
signal is the lease. Only the coordinating session sees an exited task or a killed run.

**Why it is safe enough.** `--force` rotates the token, so a previous owner that was in fact still
alive fails with exit 4 on its next `orch` command and cannot record anything in the ledger; a
`running` job becomes `interrupted`. A wrong force therefore fails safe at the ledger, though the
old session can still write into the worktree until it notices, which is why a quiet session or a
slow response is not evidence.

**What does not change.** The recovery worker still never forces a lease
(`2026-11-16-opt-in-recovery-worker.md`); it has no view of the harness. Revisit with an `orch`
liveness record if forced takeovers of live sessions show up in `job.claimed` events.
