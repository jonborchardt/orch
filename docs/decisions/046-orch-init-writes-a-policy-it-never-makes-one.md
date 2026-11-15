# 46. `orch init` writes a policy; it never makes one trusted

Onboarding a repository is a plain file write: `orch init` validates the checks the developer names
(or the `package.json` scripts they explicitly accept with `--from-package-json`) through the same
`parsePolicy` the gates use, writes `factory.json` atomically (temp file and rename, refusing to
replace an existing file without `--force`), and prints the review/commit/check sequence. It never
commits, never pushes, never runs a check, and does not touch the baseline rule in `ops/verify.ts`:
a policy written into a job worktree is still just a proposed change the plan reports as
`authorization: required`. A placeholder or empty starter policy was rejected because a committed
empty policy leaves every job at `configuration-required`; guessing commands from a language or
lockfile was rejected because an unreviewed guess that happens to pass is exactly the policy the
trust model exists to prevent. `orch init --check` answers the question the factory will ask by
reusing its code rather than approximating it: `baseRef` picks the same start point a new job's
worktree gets (`origin/<branch>` as last fetched, else the local branch, so a repository without
an origin needs only the commit), `policyAt` reads the file at that commit exactly as
`effectivePolicy` does at the merge base, and `whichSync` resolves executables without running
them. A test starts real jobs and asserts the check and `effectivePolicy` agree on the commit and
fingerprint. `orch doctor` carries a one-line summary of the same result.
