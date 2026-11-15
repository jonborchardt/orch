# 58. CI: every page, one bounded re-run per head, and a cadence the CLI computes

**Pagination.** `listChecksFor` read `check-runs?per_page=100` once; a commit with more runs (large
matrices do this) was evaluated on a partial list, and a failed required check on the second page
would have passed unnoticed when the list was unconfigured. It now reads every page of both the
check-runs and the combined-status endpoints with `gh api --paginate --slurp` (one JSON array of
pages; needs `gh` 2.41, December 2023). A page failure fails the call, so a partial view is never
recorded. Several runs of one name are either attempts of one check or independent checks, and
GitHub says which: a re-run creates a new check run with a higher id in the same check suite, so
runs sharing a suite and a name collapse to the newest; runs with the same name in different suites
(two workflows posting the same job name), or without a suite id, count at their worst instead of
whichever came first. Rejected: "worst of all runs with the name" (a superseded failure would
outvote the attempt that replaced it, and a re-run could never pass while GitHub still listed the
old run) and `filter=all` (the default `latest` already hides most superseded attempts; the suite
rule only has to be right about the ones it does return).

**Re-runs.** Decision 48 rejected re-running failed workflows as "indefinite retries with no new
information". The bound is what was missing. A flaky test or a lost runner cost a repair cycle:
builder, three reviewers, approver, and a push, to "fix" something that was not broken, with
`maxCiRepairs` at two. `orch gh ci` now requests `gh run rerun <run> --failed` once per PR head for
a required Actions check that concluded `failure`, `timed_out`, `cancelled`, `startup_failure`, or
`stale`, only after every other required check has finished (GitHub refuses to re-run a run in
progress), records it as `ci.rerun` with the head, the run ids, and the check-run ids it replaces,
and then waits. A second failure of the same commit is new information: it goes to `rework` as
before; a second cancellation still escalates. The budget is counted from events per head, so a
repaired commit gets its own single re-run, a resumed session does not get another, and the total
is bounded by `maxCiRepairs + 1`. Until GitHub reports the new attempt the replaced check-run ids
are ignored for the grace window, so a poll that lands between the request and the new runs cannot
spend a repair on the old verdict. Commit statuses from other CI systems, `action_required`, and
checks that never reported are not re-run: there is nothing to re-run or it would not help.
Rejected: classifying a `failure` as flaky from its log (a signature list would be guessed, not
measured; the deterministic rule "fail twice" needs no classifier), a configurable budget (one
value, one column less), and re-running the whole workflow (`--failed` keeps the passing jobs'
verdicts, which are still for the same commit).

**Cadence.** "Wait about a minute, release after roughly 30" was prose. The result now carries
`waitSeconds` (60 s for the first five observations of a head, then 120, 180, 240, capped at 300)
and the plan carries `sessionPolls` (observations since the current claim) and `release`, which
turns the plan's only command into `orch job release` after 20 pending observations in one
session; `orch factory resume` starts the count again, so a resumed session gets its own budget
and an interrupted one loses nothing. The CLI still never sleeps or loops; it only says how long.
Rejected: refusing a call that comes too soon after the previous observation (the only caller is
the skill, which now has an exact number; a human running the command twice is harmless, and a
refused call would read like a GitHub failure).
