# 45. The `check-readonly` flake: what is established and what is not

**Observed.** One `orch factory check-readonly` exit 1 in `tests/factory.test.ts` (test "start /
next / status / resume / config / check-readonly with --json; usage errors exit 2") during a full
parallel `npm run check` on Windows. Only the exit code was asserted, so stderr was lost. Isolated
and later full runs passed. Two factory jobs investigated it: PR #1 was closed unmerged; PR #2
landed the unreadable-HEAD handling below.

**Confirmed defect, fixed (PR #2).** `inspectWorktree` read HEAD through `tryGit`, so a failed
`git rev-parse HEAD` in a real worktree became `head: null`, changed the fingerprint, and
`check-readonly` reported "Reviewers must not modify code" for what was a Git failure. This is a
real error-handling defect. It was never shown to be the cause of the observed run. Now
`inspectWorktree` records the first failing step and Git's error in an optional `problem` field.
The steps are `rev-parse --show-toplevel`, the canonical-path comparison, `--git-common-dir` for
both sides (replacing `sameRepository`, which swallowed the error), and `rev-parse HEAD`.
`isWorktree` and every other caller behave as before; the fingerprint inputs (HEAD plus the sorted
dirty list) are unchanged. `check-readonly` treats a missing HEAD as an inspection failure: still
exit 1, message "Worktree is missing or unreadable at <path>: <step>: git rev-parse failed in
<path>: fatal: ...", never blaming a reviewer. The regression test `check-readonly reports a
failed inspection with its Git error, not as a reviewer write` covers an unreadable HEAD and a
`.git` file pointing at a missing gitdir; `check-readonly catches a reviewer that changed the
worktree` keeps the real-modification message for an added file and a moved HEAD.

**Reconstructed, not observed.** A second Claude Code session was applying the Phase 5C edits
(later 6728edc) to the same checkout while the suite ran; its transcript records the edits with
timestamps. Between 19:17:55.2Z and 19:17:59.7Z `src/git/worktree.ts` was invalid on disk (first
the `realpathSync` and `resolve` imports removed while `samePath` still used them, then `samePath`
deleted while `inspectWorktree` still called it). Imports still resolved, so modules loaded; any
CLI process started in that window threw `ReferenceError` from `inspectWorktree`, and `printError`
maps a non-`OrchError` to exit 1. The failing test ran in roughly 19:17:51-19:18:07 and
`check-readonly` sits about two thirds of the way through it, so the timing fits. Rebuilding the
tree at 6728edc with `worktree.ts` in each half-edited state and running `check-readonly` 10 times
per tree gave exit 1 10/10 for each (with `ReferenceError: resolve is not defined` and
`ReferenceError: samePath is not defined`), and exit 0 10/10 on the good tree. The original run left
no artefact that ties it to this: the mechanism is plausible and reproducible, not established as
the cause.

**Not reproduced under load.** Load runs used a frozen snapshot of b88621d, so edits could not
interfere. H1, inspection failure: looping `check-readonly` 300 times against a live job (the first
6 minutes alongside a full suite run) gave 300/300 exit 0, slowest 7.0 s, far under `spawnTool`'s
120 s timeout; the `check-readonly` tests run 6 times alongside a second full run gave 12/12. H2,
the dirty list changing: no command in the test writes into the worktree between `factory status`
and `check-readonly`, and the artifact goes under `ORCH_HOME`. Test isolation: the store, clone,
bare origin, and CLI `ORCH_HOME` are per test, worktrees live under that home, `git worktree prune`
runs only in the test's own clone, and each file runs in its own Vitest worker, so `ORCH_GH_SHIM`
is not shared. PR #1 saw 0 of 14 runs fail; PR #2 0 of 312.

**Unverified.** The cause of that one run. Treat a recurrence as unexplained unless the worktree
really changed. The CLI test's assertion now prints stderr: a `ReferenceError` or `SyntaxError`
means another mid-edit tree; a `rev-parse ...: fatal: ...` line names the Git step that failed.
Operationally: one Claude session per checkout (a parallel session takes its own worktree), and no
edits to a checkout while its suite runs.
