# dotodo merges outside the factory

**Decision.** The repository-local `dotodo` skill (`.claude/skills/dotodo`) may merge a factory
job's PR from a session, with `gh pr merge --merge --match-head-commit <ciHead>`, once the job
meets the conditions of `cannotMerge` in `src/core/workflow.ts` (completed on a passing CI verdict,
PR ready) and GitHub reports the PR open, mergeable, and at that head. The factory skill, the
agents, and `orch` are unchanged: none of them merges, and `orch`'s own Merge stays a human's click
on the dashboard.

**Why.** For this repository's own todo list the owner wants a todo taken from logged to merged
without a click. Keeping it in a local skill leaves the product's promise ("humans merge") intact
for every other repository.

**Update 2026-11-20.** `orch install` now links `dotodo` (and `log-todo`) into `~/.claude`, so the
skill, and with it this merge, is available in every repository where the owner invokes
`/dotodo`. The conditions are unchanged, and nothing merges unless that skill is invoked.

**Limits.** The conditions are prose, not TypeScript: nothing but the skill text stops a session
from merging early. A conflict after completion is never resolved by hand; it becomes a second
factory job that supersedes the first. `orch` learns of the merge only when the PR is next read
(the dashboard's Refresh PR).
