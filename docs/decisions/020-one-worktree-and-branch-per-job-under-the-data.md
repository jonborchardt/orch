# 20. One worktree and branch per job, under the data directory

Worktrees live at `<data>/worktrees/<repo slug>/<job id>` on branch `factory/<id>-<title slug>`.
Unique indexes on `jobs.worktreePath` and (`repo`, `branch`) make double assignment impossible.
`create` is idempotent and recreates a vanished directory from the surviving branch; `remove` and
`integrate` refuse on uncommitted changes, and the branch is never deleted, so nothing `orch` does
can lose work. Ownership (the token) gates every mutating command, but it is advisory against a
process that writes into another worktree directly; that is documented rather than pretended away.
