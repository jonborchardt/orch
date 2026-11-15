# 43. Integration is recorded first and reconciled from Git

`integrateBase` writes an `integrations` row (job HEAD, base SHA, merge base, approval commit,
valid run) before merging and completes it after (result, conflicts, changed files, `material`
from `git diff-tree --cc`, which is empty for a clean merge and lists every file whose result
matches neither parent otherwise). A `started` row on the next call means the previous process
died: `MERGE_HEAD` present means abort (nothing committed is lost), a merge commit with the
recorded parents means record it, otherwise mark interrupted. In the `pr` stage, conflicts or
material edits send the job back to `build` with the new `rework` action, so the resolution is
built, verified, reviewed, and approved like any other change; a clean merge needs only a fresh
`orch verify`. The push gate re-checks all of this against the commit actually being pushed. A
full re-review for a clean base update was rejected as cost without evidence; a review for any
edit inside a merge was accepted because the CLI cannot tell a trivial resolution from a hidden
change.
