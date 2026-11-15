# 49. A job is bound to its repository by Git common directory, not by remote identity

The first real factory run created a job in a repository without a remote (identity `orch`, the
directory name), then gained a GitHub `origin`. `describeRepo` now reported `github.com/<o>/orch`,
every gate compared that to `job.repo` and refused the job's own checkout, and only the manual
`orch job repo` command could recover it. The remote identity was doing two jobs: naming the
repository for grouping and PR delivery (where it belongs) and proving that a path is the job's
repository (where it is wrong, because it changes whenever the remote does).

`ops/repo.ts` separates them. The stable local identity is the canonical Git common directory of
the recorded checkout (`commonGitDir`, through `canonicalPath`, so case, 8.3 aliases, junctions,
and spaces compare equal); the checkout and all its linked worktrees share it, and no remote
operation moves it. `job.repo` stays the remote identity: it follows the remote (refreshed on the
next authorized mutation and recorded as `repo.repointed`), groups jobs in the dashboard, is
checked against GitHub before a PR, and is how `--repo <other clone>` is recognised. A
directory-name identity never matches another repository: nothing proves two directories called
`proj` are related. Mismatches that cannot be reconciled say what is stored, what was found,
whether the recorded checkout still exists, and why no remote can bridge them.

Rejected: storing the common directory as `job.repo`. It would change the persisted format for
every existing row, turn worktree slugs and dashboard groups into filesystem paths, and break
`--repo <other clone>`, for no safety the on-demand comparison does not already give. No schema
change was needed: `repoPath` was already the anchor; it was simply not what the gates compared.
A changed identity at the recorded path is adopted only on evidence, because nothing stored tells
a remote change apart from an unrelated repository placed at that path. The job's worktree is the
evidence: it was created from the job's repository and still names its common directory, so the
checkout must share it; a worktree that resolves elsewhere, or no longer resolves at all, means the
checkout was replaced and every mutation (including `orch job repo`) refuses. Without a worktree
only an operator can vouch, so automatic reconciliation stops and `orch job repo` is the explicit
confirmation. The check runs before `setRepo`, so a refused checkout never reaches the row.
