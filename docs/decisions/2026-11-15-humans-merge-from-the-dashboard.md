# Humans merge from the dashboard; the factory still never does

Supersedes the "never merge" clause of decision 22 (`022-github-through-gh-with-a-shim-for-tests.md`)
and of `2026-11-15-orch-marks-a-passing-pr-ready.md` for one path only: a human clicking **Merge**
in `orch ui`. Everything else in both stands.

**Decision.** `mergePr` in `src/integrations/github.ts` is the only `gh pr merge` in the source,
and `dashboardAction` in `src/ops/actions.ts` (action `merge`) is its only caller. There is no CLI
command, so the factory skill and agents, which can only call `orch`, still cannot merge.

- Offered only for a job completed on GitHub's verdict (`completion: 'ci'`), with `prState: ready`,
  `ciStatus: passing`, and `ciHead` set (`cannotMerge` in `src/core/workflow.ts`).
- On the click, the server reads the PR again and merges only if it is `OPEN`, not a draft, its
  head equals `ciHead`, and `mergeable` is `MERGEABLE`. The call is
  `gh pr merge <url> --merge --match-head-commit <ciHead>`: never `--delete-branch`, `--admin`, or
  `--auto`.
- One owner-checked write (`recordPrState`): event `pr.merged` `{ head, ok, error }`, and
  `prState: merged` only on success. A refused merge is recorded with gh's message and returned
  as the error. Stage, status, and the CI verdict never change.
- **Refresh PR** (`refresh-pr`) re-reads the PR and records only `prState` (event `pr.observed`).
  A merge is never inferred, and nothing polls GitHub.

**Why.** Merging stays a human decision; the button only removes the trip to GitHub, and it
merges exactly the commit the passing verdict was recorded for. Keeping it out of the CLI keeps
the factory's own path unable to merge, and `tests/audit.test.ts` holds both limits.
