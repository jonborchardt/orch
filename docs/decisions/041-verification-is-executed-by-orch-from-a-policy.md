# 41. Verification is executed by orch, from a policy the job did not write (Phase 5B)

`build.md` used to be the only record that tests ran. `orch verify` now runs the checks itself and
records a run (`verification_runs`) with every expected check rowed as `pending` before the first
one starts (`verification_checks`), so a crash leaves an obviously incomplete run. The policy is
`factory.json` at the repository root, parsed strictly into executable names and argument arrays
(`core/verification.ts`), executed with `spawnCommand` (`core/exec.ts`: PATH resolution, Windows
`.cmd` shims through `cmd.exe` with plain tokens only, timeouts with SIGKILL, capped output). The
effective policy is read from the merge base of the job branch and the base branch, which the job
cannot have authored; a human can replace it per job through the dashboard (`accept-policy`,
snapshotted in `jobs.policy`). No policy means `configuration-required`, and the gates stay shut:
inventing checks or passing by default would make the evidence worthless. Checks run in order and
stop at the first failed required check; the rest stay `pending`. Validity (`runInvalidReason`) is
recomputed at every gate from HEAD, the tree hash, the dirty list, the policy fingerprint, and the
check rows; HEAD alone is not trusted because the same commit can carry a different tree only
through uncommitted files, which is why a dirty worktree is refused outright rather than recorded.
