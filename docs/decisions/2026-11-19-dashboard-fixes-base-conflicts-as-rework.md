# The dashboard fixes base conflicts as rework

**Decision.** The job detail shows **Fix merge conflicts** (`fix-conflicts`) when the job has
conflicts with its base and is either in `approve`, `pr`, or `ci` (not finished), or `completed`
with an open PR (`prState` `draft` or `ready`) that no job superseded yet. "Has conflicts" means
`git merge-tree --write-tree` of the worktree HEAD against the local base ref `integrateBase`
merges reports files (read-only: no fetch, no worktree, index, or ref change; a probe error or a
10 s timeout counts as none), or the newest recorded GitHub observation of the PR (`pr.observed` or
`ci.observed`, which now carry `mergeable`) says `CONFLICTING`. An observation without the field
counts as unknown, and a newer non-CONFLICTING one overrides an older CONFLICTING one.

For `approve`, `pr`, and `ci` the action re-checks the rule, then runs the existing `integrateBase`
in a short `dashboard` lease episode: the conflicting merge is aborted and recorded, the job goes
back to `build` through `rework`, and the job is released. `rework` takes an `integration` flag
(passed only by `integrateBase`, recorded as `integration: true` on `job.reworked`): from `ci` it
then reworks like approve and pr, spending no CI repair and never escalating for an exhausted
budget. In `ci` a clean merge reworks too, because only the `pr` stage pushes. `orch worktree
integrate` follows the same rule.

A completed job cannot transition, so it is re-landed the way the dotodo skill does it: the click
re-reads the PR and requires `OPEN` and `CONFLICTING`, creates a `<title> (re-land)` job through
`dispatchJob` (created only: no claim, worktree, or session) whose description adds the re-land
sentence, then records `supersede <old> --by <new>`. A human starts `/factory <new id>` and closes
the old PR once the new one merges. orch resolves nothing and starts no session in any case.

**Why.** Before this, a human had to notice the base moved, find the owner token, and run
`orch worktree integrate` by hand, and a ci or completed job had no route at all. A base conflict is
not a CI failure: spending a repair would make an exhausted job escalate with a false "max CI repair
cycles reached". Reopening a terminal job would break the terminal-status rule; a replacement job
keeps both histories.

**Limits.** `needs-human` (a human first resumes it to its stage), cancelled and superseded jobs,
and stages before `approve` are excluded; there `integrateBase` raises a conflict as an error.
Base-integration reworks are not bounded by `maxCiRepairs`, only by human clicks and base movement.
The probe uses the local base ref and the GitHub signal is only as fresh as the last `orch gh ci`
or Refresh PR, so the button can be missing or be refused on click (ci: nothing to merge;
completed: GitHub no longer CONFLICTING). A failure to record the supersede after creating the
re-land job is reported with the new id for a human to finish. `git merge-tree --write-tree` needs
Git 2.38 or later.
