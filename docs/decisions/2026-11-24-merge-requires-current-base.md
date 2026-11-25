# A merge requires the verified head to contain the current base

**Decision.** `mergeDecision` merges only when GitHub's compare
(`repos/<repo>/compare/<base>...<ciHead>`) says `behind_by` 0: the head CI passed on contains the
base's current tip. No usable answer is `wait`. A moved base is the `base-moved` step, checked
after every existing refusal and after a `CONFLICTING` PR (which still re-lands). `mergeJob`
resolves it without a human: it integrates the base with `integrateBase` while the job is still
completed, and only once that merge commit exists reopens the job from `completed` to
`pr`/`pending` (`job.reopened`). The controller then runs `/factory <job>` for `pr` as for any
delivery, so the next merge happens only at a new `ciHead` that CI passed on. A job is reopened at
most `MAX_BASE_REOPENS` (2) times; then `base-moving` goes to a person. A sibling unfinished job on
the ticket, a missing worktree, a dirty tree, or a Git failure is `reopen-refused` and leaves the
job completed.

**This narrows the terminal-status rule** of
`2026-11-19-dashboard-fixes-base-conflicts-as-rework` ("reopening a terminal job would break the
terminal-status rule; a replacement job keeps both histories") to one case: a job completed by a
passing CI verdict, with an open PR, not superseded, and no other unfinished job on its ticket,
whose base GitHub says moved, and for which a clean merge commit already exists. The reopen is a
storage rule of its own (`reopenForBase`, applied by `reopenJob`), not an `ACTIONS` entry, so
`orch job transition` cannot reach it. Conflicts still get a replacement job.

**Why.** Without GitHub's "require branches to be up to date" rule, orch could merge a base and
head pair no check ran on. A replacement job would keep the rule, but for a clean merge it would
rerun spec, build, and review, and open a new PR, to deliver the same reviewed work plus one merge
commit. Reopening into `pr` verifies, pushes, and checks exactly that commit on the same PR, and
the job's history stays in one place. The residual race (the base moving between the compare and
`gh pr merge`) is documented, not closed: `--match-head-commit` pins only the head, and a merge
queue is out of bounds.
