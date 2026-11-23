# A PR that changes `.github/workflows/` is merged only by a human

**Decision.** `mergeDecision` (`core/workflow.ts`) blocks with `workflow-changed` when the PR
touches `.github/workflows/` and the merge is not a human's dashboard click
(`MergeFacts.changesWorkflows && !byHuman`). It is checked after `head-changed` and before
`not-authorized`, so `mergeRepos` does not lift it, and recording a PR GitHub already merged is
unchanged. The rule applies to every repository, whatever its verification authority.

**Source: GitHub, not local Git (ticket 0119).** `ops/merge.ts` computes `changesWorkflows` from
GitHub's file list for the PR being merged (`listPrFiles` in `integrations/github.ts`:
`gh api repos/<owner>/<name>/pulls/<n>/files --paginate --slurp`), never from the local clone or
the repository's files. Every `filename`, and every `previous_filename` of a rename, is matched by
the pure `touchesWorkflows` (prefix `.github/workflows/`, or exactly `.github/workflows` or
`.github`, which is how a symlink or gitlink replacing either directory appears; case-insensitive),
so an addition, edit, deletion, or rename in either direction counts. The value is true (fail
closed) when:

- the files call fails, returns invalid JSON, or does not return a list of pages (a failed page
  fails the whole call);
- the PR read (`gh pr view --json changedFiles`) gives no `changedFiles` count;
- the number of entries differs from `changedFiles`, which covers GitHub's 3000-file cap,
  truncated pagination, malformed entries (dropped, so the list comes up short), and a list GitHub
  has not finished computing.

**Head binding.** In each read of the PR the file list is fetched before the `gh pr view` that
`mergeDecision` judges, so the list is no newer than a head that must equal `ciHead` (otherwise
`head-changed`), and `gh pr merge --match-head-commit <ciHead>` refuses a head that moves
afterwards. Residual: someone with push access who moves the head away and back between the files
read and the merge could pair a stale list with `ciHead`; that window is a few seconds and needs
write access to the branch. GitHub also computes a PR's file list asynchronously after a push; a
job's head was pushed long before its CI passed, so a stale list with a matching count is
accepted.

**Why the 0118 local checks were removed, not kept as a second opinion.** Ticket 0118 hardened a
local `merge-base` plus `diff` against replace refs, grafts, a shallow file, the commit-graph, and
`diff.ignoreSubmodules`, one review round at a time, and a spoofed base ref (a repointed
`refs/remotes/origin/main`, a same-named tag or branch, or the worktree's `.git` file) stayed open.
`changesWorkflows` can only add a block, so a local check OR-ed in never stops an attacker who
controls `.git` (they make it say "no change"); it would only add false blocks from odd clones and
keep that treadmill going. GitHub's list is the set of files GitHub merges and runs workflows from,
so it is the single source, and the base-ref spoof is closed with it.

**Exception to decision 042.** Decision 042 keeps sensitive paths (CI among them) labelled, not
blocked, with reviewers as the control. This is the one place a path blocks, and only at merge
authorization: labelling in `core/sensitive.ts` is unchanged, and a human can still merge from the
dashboard.

**Why (security).** GitHub runs the workflow as it exists on the PR branch, so a job can change the
very checks that judge it: drop the test step, mark a job `continue-on-error`, or skip a path, and
the verdict that completes the job and allows the merge comes back green. Under
`verification.authority: "ci"` that verdict is the only test run, and with `mergeRepos` enabled
nobody would look before the merge. Requiring a human click for exactly these files keeps the
judge out of the defendant's hands without blocking any other change. The check reads the PR's
files from GitHub at merge time, so nothing in the PR or the local clone (a file, a setting, a
policy, a ref) can turn it off, and branch protection is not relied on alone, since many
repositories have none. It applies in `local` mode too, because CI runs the branch's workflow
there as well; the alternative, applying it only under `ci`, would need a policy read at merge time
for a weaker guarantee.

**Left out.** Package scripts, test configuration, and other CI files (existing review covers
them), the `compare` API, retries, and any opt-out.
