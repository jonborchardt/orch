# Reviewer read-only is enforced at review-round completion

**Decision.** No new mechanism. A review round cannot complete with PASS if a reviewer left a
committed change or an outstanding non-ignored change, because the existing gates already refuse
both:

- **Committed change.** `transitionGuarded` in `src/ops/gates.ts` requires that the HEAD of the
  round's verdicts equals the worktree's current HEAD ("the implementation changed since that
  evidence was collected") and equals the HEAD `build.md` was registered against ("the code
  changed after the build"). `verifyReviewers` in `src/core/workflow.ts` separately requires every
  verdict in the round to name the same HEAD, so the pure rule refuses mixed heads even if the gate
  is bypassed. `worktreeOf` rejects a switched or detached branch.
- **Outstanding change.** `recordVerdict` calls `requireClean` before recording a verdict, and
  `transitionGuarded` calls it again at completion. Both use
  `git status --porcelain --untracked-files=all`, so tracked edits and untracked files count.

This supersedes, by reference, the line in decision 40 that describes `orch factory
check-readonly` (decision 28) as the enforcement: check-readonly remains a diagnostic, and the
completion gate is strictly stronger for the final state.

**Accepted on purpose.** An edit that is fully reverted before completion (same HEAD, clean tree,
including a commit undone before any verdict, a stash, or a new local branch) leaves nothing to
deliver, so the round completes. Writes into gitignored paths (`dist/`, `node_modules/`) are not
seen by `requireClean` and never reach a commit or push. Detecting either would need filesystem
monitoring or new state for no delivery benefit.

**Pinned by** `tests/audit.test.ts`:

- "a verdict cannot be recorded while the worktree has uncommitted changes"
- "verdicts given against different commits cannot complete the round"
- "a commit after all verdicts makes the round stale" (also a dirty file, and completion once it
  is removed)
- "verdicts all given against a commit made after build.md cannot complete the round"
