# A re-land starts from the superseded branch

**Decision.** When `createWorktree` creates a new branch for a job with exactly one predecessor
(another job's `supersededBy` points to it) whose recorded branch resolves (local
`refs/heads/<branch>`, else `origin/<branch>`), the branch starts at that head instead of the
base. The `worktree.created` event and `WorktreeResult` record `from: { ref, sha }`. For such a
seeded re-land in `spec` or `build` and behind its base, the `base-moved` notice and the plan say
the builder merges the base in `build`, resolves the conflicts, and commits the merge, and not to
run `orch worktree integrate` before that. When the branch is not found, the re-land starts from
the base and the plan says the work is re-implemented. Nothing merges or rebases automatically,
and no stage is skipped: the resolution is reviewed as new code.

**Why.** A re-land created from the base met no conflict when it integrated `main`, so its
session wrote the change again from the ticket and the reviewed commits were lost (ticket 0135,
S2 in `runner-validation.md`). Starting from the old head makes the conflict real, and the
builder's manual merge is the same step a base-integration rework already asks for. The
alternative, saying honestly that a re-land re-implements, keeps discarding reviewed work.
`origin/<branch>` can be older than the PR head because `createWorktree` does not fetch, so the
local ref, written by the old job's own worktree in the same clone, is preferred.
