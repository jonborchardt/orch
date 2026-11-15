# 39. Only approved commits leave the machine

`orch gh push` and `orch gh pr create` require the `pr` stage, a registered `DECISION: APPROVE`
with a head, and that `git rev-list --no-merges <approved>..HEAD ^<base>` is empty, so the only
commits after an approval are base-integration merges. The job branch must differ from the base
branch, and `worktree adopt` refuses a worktree on the base branch or inside the initiating
checkout. `pr complete` also requires the approval, so a human `resume --to pr` cannot finish a job
the approver never passed, and `approve complete` refuses while the last round's `consolidated.md`
counts blocking findings; a round with all-PASS verdicts but `BLOCKING: n > 0` goes back to build.
