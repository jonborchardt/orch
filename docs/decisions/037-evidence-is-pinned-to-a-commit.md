# 37. Evidence is pinned to a commit (Phase 5A audit)

Reviews used to be recorded against "the worktree", and `check-readonly` compared a fingerprint
only if the coordinator ran it. That left three holes: reviewers could read different commits while
the builder kept committing, a commit after the last verdict was still accepted, and a dirty file
whose _content_ changed between reviewers kept the same fingerprint. Now `artifacts.head` and
`reviews.head` record the worktree HEAD; `src/ops/gates.ts` (the only Git-aware path into
`registerArtifact`, `recordReview`, and `transition complete`) refuses `build.md`, review verdicts,
and `decision.md` from a dirty worktree, and refuses to complete `build`, `review`, or `approve`
unless HEAD still equals the recorded head and the tree is clean. The pure `transition` separately
rejects a round whose verdicts name different heads, so bypassing the gate does not help. Stage
completion also re-hashes the artifacts it depends on, so a file edited after registration is not
evidence. Workflow artifacts are locked to their stage and round (`assertStageOwns`), which is what
stops `decision.md` or an old round from being rewritten after approval. The remaining gap is a
conflict resolution inside a base-integration merge commit, which is accepted as a merge.
