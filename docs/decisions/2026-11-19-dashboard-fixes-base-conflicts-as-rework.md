# The dashboard fixes base conflicts as rework

**Decision.** The job detail shows **Fix merge conflicts** (`fix-conflicts`) when a job in `approve`
or `pr`, not finished, is behind its base and `git merge-tree --write-tree` of the worktree HEAD
against the same local base ref `integrateBase` merges reports conflicting files. The probe is
read-only (no fetch, no worktree, index, or ref change) and runs only for such jobs; a probe error
hides the button. The action re-checks the same rule, then runs the existing `integrateBase` in a
short `dashboard` lease episode: the conflicting merge is aborted and recorded, the job goes back to
`build` through `rework`, and the job is released. orch resolves nothing and starts no session; the
result returns the usual `orch factory resume` command, and the builder resolves on resume.

**Why.** Before this, a human had to notice the base moved, find the owner token, and run
`orch worktree integrate` by hand. `approve` and `pr` are the stages where a base conflict already
means rework, so the button adds no workflow rule, only a way to reach the existing one.

**Limits.** Finished jobs (for example a completed job whose PR GitHub reports `CONFLICTING`) are
excluded: terminal jobs cannot rework, and reopening one is a larger change. The `ci` stage (where
rework spends a CI repair), `needs-human`, and earlier stages are excluded too; there
`integrateBase` raises a conflict as an error. The probe uses the local base ref, so it can miss a
new conflict or show one already fixed upstream; the click fetches and acts on the truth, and a
merge that comes out clean is committed and needs verification. `git merge-tree --write-tree`
needs Git 2.38 or later.
