# 29. One factory start command

`orch factory start` creates, claims, and gives a worktree to a job in one call and returns the
token with the first plan. Three separate commands would be three chances for the coordinator to
drop the token or skip the worktree. `start` fetches the title from an issue through `gh` when only
`--issue` is given.
