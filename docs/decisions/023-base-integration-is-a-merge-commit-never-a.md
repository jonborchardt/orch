# 23. Base integration is a merge commit, never a rebase

`orch worktree integrate` fetches `origin/<base>` and merges it with `--no-ff`; conflicts abort the
merge and report the files. Rebase would rewrite a branch that may already be pushed and reviewed.
Validation after integration is the skill's responsibility (it re-runs the project's checks).
(Since decisions 41 and 43 that validation is `orch verify`, and the merge is recorded first.)
