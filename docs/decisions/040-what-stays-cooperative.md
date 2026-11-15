# 40. What stays cooperative

The CLI cannot stop a process from writing into any directory or the database file. It can only
decline to treat such writes as progress. Things that rest on agent behaviour, listed so nobody
mistakes them for enforced: subagents staying in the worktree (the plan now reports dirty files in
the initiating checkout so a stray write is visible), reviewers rerunning tests rather than trusting
`build.md`, builders not weakening tests, `orch doctor` being run so stale managed agent copies are
noticed, and the coordinator running `check-readonly` and `fail` when it trips.
