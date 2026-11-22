# A PR that changes `.github/workflows/` is merged only by a human

**Decision.** `mergeDecision` (`core/workflow.ts`) blocks with `workflow-changed` when the job's
diff touches `.github/workflows/` and the merge is not a human's dashboard click
(`MergeFacts.changesWorkflows && !byHuman`). It is checked after `head-changed` and before
`not-authorized`, so `mergeRepos` does not lift it, and recording a PR GitHub already merged is
unchanged. `ops/merge.ts` computes `changesWorkflows` from Git, never from the repository's files:
`git --no-replace-objects diff --name-only --no-renames -z <merge-base(base, ciHead)> <ciHead>`
(the merge base also read with `--no-replace-objects`, so a `refs/replace/*` entry cannot hide a
change), matched by the pure `touchesWorkflows` (prefix `.github/workflows/`, or exactly
`.github/workflows` or `.github`, which is how a symlink or gitlink replacing either directory
appears; case-insensitive), so an addition, edit, deletion, or rename (both sides) counts. When Git
cannot answer, the value is true: fail closed. A graft file (`git rev-parse --git-path
info/grafts`, which honours `GIT_GRAFT_FILE`) also makes it true, since a graft rewrites parents,
can make the head its own merge base, and is not turned off by `--no-replace-objects`. The rule
applies to every repository, whatever its verification authority.

**Exception to decision 042.** Decision 042 keeps sensitive paths (CI among them) labelled, not
blocked, with reviewers as the control. This is the one place a path blocks, and only at merge
authorization: labelling in `core/sensitive.ts` is unchanged, and a human can still merge from the
dashboard.

**Why (security).** GitHub runs the workflow as it exists on the PR branch, so a job can change the
very checks that judge it: drop the test step, mark a job `continue-on-error`, or skip a path, and
the verdict that completes the job and allows the merge comes back green. Under
`verification.authority: "ci"` that verdict is the only test run, and with `mergeRepos` enabled
nobody would look before the merge. Requiring a human click for exactly these files keeps the
judge out of the defendant's hands without blocking any other change. The check reads the merged
range from Git at merge time, so nothing in the PR (a file, a setting, a policy) can turn it off,
and branch protection is not relied on alone, since many repositories have none. It applies in
`local` mode too, because CI runs the branch's workflow there as well; the alternative, applying it
only under `ci`, would need a policy read at merge time for a weaker guarantee.

**Left out.** Package scripts, test configuration, and other CI files (existing review covers
them), and any opt-out.
