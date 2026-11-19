# Integrate base before reworking unchanged-file failures

**Decision.** Three additions to the likely-flaky label (decision
2026-11-18-flag-likely-flaky-verification-failures), all still labels:

- **Integrate first.** When the job's latest run failed at HEAD, its shown flag is rule (b)
  (`unchanged-file`) on that run, and the worktree is `behind` its base, `integrateFirst` in
  `src/core/flake.ts` holds. The plan for `build`, `simplify`, `approve` and `pr` then opens its
  reason with "integrate base (orch worktree integrate <id>), then verify again; do not rework
  someone else's test", and (except in `pr`, which already integrates a moved base) puts
  `orch worktree integrate` before the stage's `orch verify`. The failing `orch verify` gives the
  same advice in its hint instead of "Fix, commit, and run orch verify again."
- **One machine-wide cause.** `currentFlakes` in `src/ops/verify.ts` reads every unfinished job's
  shown flag in one pass and fills `flake.sharedWith` with the other jobs whose flag names the same
  first test (file and name). `orch factory status`, the board, and the detail then show one line,
  "likely machine-wide flaky test (also failing in <ids>)". A new `unchanged-file` flag whose test
  other jobs already carry says so in its event reason, which is what status mail prints.
- **Dismissal.** A flag is no longer shown once the job has a `passed` run with a higher id than
  the flagged run. The event stays in the timeline and in mail.

**Why.** A slow test on `main`, fixed by a later merge, failed verify in three jobs at once; each
owner burned runs on it and had to be told by hand to merge base. The label already said "the job
did not change this file"; the plan still sent the builder to fix it. A LICENSE-only job kept
showing its stale flag after later runs passed.

**Limits.** `behind` is measured against the local `origin/<base>`, which may be stale until the
next fetch; `orch worktree integrate` fetches, and the plan never does. Rule (a) flags are created
by the pass that dismisses them, so they appear only in the timeline and mail. Sharing compares only
the first parsed test. GitHub CI failures in the `ci` stage are unchanged (decision 58).
