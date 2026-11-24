# A clean base merge keeps simplify evidence valid for review

**Decision.** Completing `review` accepts verdicts for a commit other than the one this round's
`round-N/simplify.md` (or `build.md`) describes when the reviewed commit follows it by clean base
merges only: it contains that commit, and every commit since then that is not on the base is a
merge whose result matches one of its parents (empty `git diff-tree --cc`). The rule is the pure
`reviewedHeadRefusal` in `src/core/workflow.ts`; the review branch of `transitionGuarded` in
`src/ops/gates.ts` gathers the Git facts (`containsRef`, `rev-list --no-merges ... ^base`,
`editedMerges`, `baseRef(path, job.baseBranch)`) and refuses when Git cannot answer. A non-merge
commit after simplify, or a merge with edits inside it, is still new code and is still refused
(ticket 0131).

**Rationale.** Under `verification.authority: "ci"` the order is build, simplify, pr, ci, review.
When the base moves while the job waits in `pr`, a clean `orch worktree integrate` creates a new
HEAD that is verified and passes CI, but the old gate wanted the verdicts' head to equal
simplify.md's, and `rework` is not legal from `review`, so the session could only escalate
(job-14854320). A clean merge adds nothing the job wrote; it is exactly what delivery already
accepts after an approval (`requireApproved`), so review uses the same rule.

**Rejected: rework from review.** The ticket's other option was to let the review gate send the
job back to build. That needs a new `rework` move from `review` in `transition`, and it would rerun
build and simplify for a change that has nothing to simplify. An edited merge that reaches review
(rare: `integrateBase` already reworks material merges in `approve`, `pr`, and `ci`, so it only
arrives when someone merged by hand) still has only escalate. A clean merge in the `ci` stage still
reworks by `integrateBase`'s existing rule; that is unchanged here.
