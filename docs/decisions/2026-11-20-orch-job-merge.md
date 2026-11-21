# `orch job merge`: one merge operation, opt-in per repository

Supersedes the "there is no CLI command" clause of `2026-11-15-humans-merge-from-the-dashboard.md`
and the whole of `2026-11-18-dotodo-merges-outside-the-factory.md`, and narrows "nothing completes
a ticket except `orch ticket done`" from `2026-11-20-global-ticket-queue.md`.

**Decision.** `mergeJob` in `src/ops/merge.ts` is the only caller of `mergePr`, the only
`gh pr merge` in the source. The dashboard's Merge and the new `orch job merge <id>` both call it;
whatever runs jobs unattended later calls it too. The rule it applies, `mergeDecision` in
`src/core/workflow.ts`, is pure: the job row plus GitHub's answer from this call.

- **Authorization.** A human's dashboard click is its own authorization, as before. Every other
  caller needs the repository opted in: `orch factory config merge enable|disable|status
[--repo <path>]` keeps a list of repository identities (`mergeRepos`) in the user's own
  `factory.json` under the orch config directory. It is off by default, nothing turns it on
  implicitly, and no file inside a repository is consulted. The opt-in lifts no gate. Recording a
  merge GitHub already made needs no opt-in, since it merges nothing.
- **Gates for a new merge**, all from fresh state: the PR is in the job's repository, targets
  `job.baseBranch`, comes from `job.branch` (not a fork); the job is completed by a passing CI
  verdict with `ciHead` set and is not superseded; the PR is open, not a draft, at `ciHead`, and
  `MERGEABLE`. The merge is `gh pr merge --merge --match-head-commit <ciHead>`; `--admin`,
  `--auto`, `--delete-branch`, squash, rebase, and `gh pr close` stay out of the source
  (`tests/audit.test.ts`). Branch protection is enforced by GitHub; a refusal is reported, never
  worked around.
- **GitHub is the authority on the result.** After the merge command, whatever it exited with, the
  PR is read again. Only `MERGED` with a merge commit is recorded. So a timeout after a successful
  merge is a success, and a crash before the local write is repaired by the next call, which finds
  the PR merged and records it without merging again.
- **Evidence.** One event, `pr.merged` with `ok: true`: the merged head, GitHub's merge commit, the
  verified head (`ciHead`), `verified` (the two heads are equal), the base, the PR URL, and the
  ticket id. `prState` becomes `merged`. No new table or column, and no new stage: a completed job
  stays completed.
- **The ticket.** The same transaction closes the job's ticket when the merge is verified, the job
  is not superseded, no other job is working on the ticket, and the ticket body has no unchecked
  Markdown task item (`- [ ]`); the `ticket.completed` event carries the job, PR, head, and merge
  commit. Otherwise the ticket's status is left alone and the reason is recorded once
  (`ticket.job-merged`). A ticket already done, dropped, or marked duplicate is not touched. orch
  never ticks a box; running the command again after the boxes are ticked closes the ticket.
- **Conflicts.** `CONFLICTING` creates one re-land job on the same ticket and marks the old job
  superseded, in the transaction that inserts the new job (`createJob`'s `supersedes`), so a
  re-land never exists without its supersession and a retry cannot create a second. A job that is
  itself a re-land (it has a predecessor) is not re-landed again. A superseded job never merges.
  The old PR is left open: orch closes no PRs.
- **No queue, no lock, no daemon.** Each call reads the PR and decides without owning the job;
  only a step that writes claims it for one short episode and reads GitHub again inside it.
  `UNKNOWN` mergeability returns `waiting` at once. The command exits 0 only for `merged` and
  `already_merged`.

**Why.** Unattended runs need a merge that does not depend on a click, and the previous answer
(the `dotodo` skill running `gh` itself) kept the rules in prose where nothing enforced them.
Putting them in one deterministic operation makes the CLI path stricter than the skill was (it adds
the repository and branch checks, the supersession check, and the confirmed result), and an
explicit per-repository opt-in keeps "humans merge" true everywhere the user has not said
otherwise. A persistent merge queue or a per-repository lock would guard nothing here: each merge
is atomic and head-pinned at GitHub, and the result is not re-verified against the new base.

**Taken from** (ideas only, no code): OrchestratorInc/agent-orchestrator at `7919c96`
(`backend/internal/service/pr/action_service.go` `Merge` and `domain/pr.go`
`MergeReadiness.ReadyToMerge`: check the stored head, a fresh head, and the head CI ran for before
merging; unknown is never ready) and gastownhall/gastown at `94cc822` (`internal/cmd/mq.go`
`runVerifiedMQPostMerge` with `internal/refinery/terminal_mr.go`: prove the merge, then close the
work item, each step tolerating "already done"; `recheckMRStillMergeable` in
`internal/refinery/engineer.go`: re-check branch, target, and commit before acting).

**Limits.** "Verified" means GitHub merged the head CI passed on; nothing runs on the merged
result. Anyone who can run `orch` can opt a repository in: the opt-in separates repositories, not
people. GitHub review requirements are enforced by GitHub alone and surface as a refused merge.
