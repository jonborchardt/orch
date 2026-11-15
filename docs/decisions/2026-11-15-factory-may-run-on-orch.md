# The factory may run on orch itself

**Context.** `CLAUDE.md` forbade `/factory` against this repository, on the grounds that a job
editing `src/` would be gated by the code it changes. In practice several jobs ran on orch and
delivered (PR #34 among them), and the concern does not hold: the gates a job passes through are
the installed `orch`, which is the primary checkout's built `dist/`, while the job edits its own
worktree.

**Decision.** `/factory` may run against orch. A job's branch is exercised only by its own
verification run (`factory.json` at the merge base, in its worktree). `dist/` is rebuilt from
`main` only, so a job never runs under gates built from its unmerged branch.

**Rejected.** Dedicated self-hosting infrastructure (a pinned second install, a separate data
directory): nothing has failed that it would have prevented.
