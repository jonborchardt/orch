# 48. Delivery ends with GitHub's verdict for the PR head, read by the CLI (post-PR CI)

The first real factory job reported success with PR #1 failing CI, because `pr` completed the job
once a PR URL was recorded. A `ci` stage now follows `pr`, and completing it requires
`jobs.ciStatus = passing` recorded for `jobs.ciHead` by `orch gh ci`, with `ops/gates.ts` adding
that `ciHead` is still the worktree HEAD. The rollup is not taken from `gh pr view`
(`statusCheckRollup` describes whatever the head is at that moment); the command reads
`/commits/<sha>/check-runs` and `/commits/<sha>/status` for the SHA it then records, so a verdict
can never be borrowed from another commit, and it reads classic protection plus rulesets to know
which checks are required. Without that list every reported check is required and an empty or
skipped-only list is not a pass: it waits through a short grace window (checks register a few
seconds after a push) and then escalates, because inventing success is exactly the failure mode
being fixed. Failures that a builder can act on (`failure`, `timed_out`) save the Actions job log
under the artifact directory and go through the existing `rework` action, so the repair is built,
verified, reviewed, approved, and pushed to the same PR like any other change; the pure
`transition` counts them in `jobs.ciRepairs` and escalates at `jobs.maxCiRepairs` the way review
rounds escalate at `maxRounds`. Outcomes that are not code defects (cancelled, startup failure, a
required check that never reported, a closed PR, a head that moved outside the job) escalate
without spending a repair, and a `gh` failure records nothing. Pending checks record only the
observation: the CLI stays one-shot and never sleeps or polls, the coordinator re-runs it or
releases the job, and a resumed session re-reads GitHub rather than trusting the stored rollup.
Three columns were added (`ciHead`, `ciRepairs`, `maxCiRepairs`) because the SHA binding and the
budget must be visible to the pure transition; events alone would have moved the rule into prose.
`resume --to completed` was opened for exactly one case, a `ci` escalation with no checks at all
(or a PR a human already merged), so a repository without CI has a human recovery path that cannot
be used to step over a failing or pending check. Rejected: completing `pr` when the rollup looked
green at creation (that is the bug), a repository-side declaration of required checks in
`factory.json` (GitHub already holds that configuration and it would widen the policy format),
re-running failed workflows automatically (indefinite retries with no new information), and
treating a CI failure as a lighter "fix and push" path that skips review (edits after an approval
are unapproved code, decision #39).
