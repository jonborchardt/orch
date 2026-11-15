# 62. Local test time is subprocess time; the dashboard's cost is the plan, not the artifacts

**Measured (Phase 4, this 12-core Windows workstation, shared with other sessions).** The full
Vitest suite at `main` took 890 s and 1065 s wall-clock in two runs with the default worker count
(11 forks); the per-file durations summed to 4879 s and 5721 s, so the files spent most of their
time waiting on each other, and the wall clock was `tests/ci.test.ts` alone (887 s and 1059 s),
which ran from the first second to the last. One CI-stage test's fixture work (`makePolicyRepo`,
`startJob`, `toCi`, one `reconcileCi`) spawned 326 Git and Node processes: 25 worktree
inspections at 10 or 11 `git` calls each account for 260 of them. A `git rev-parse` that answers
one question costs the same process start as one that answers four. Under that load a Git
process took 100 to 290 ms; the test files are spawn-bound, as decision 50 found on the 2-core
runners.

**Changed.** `inspectWorktree` asks `rev-parse` for `--show-toplevel` and `--git-common-dir` in
one call and for `HEAD` and `--abbrev-ref HEAD` in another: 10.5 → 8.5 processes per inspection,
326 → 284 (−13%) per CI-stage test, 12% less time in subprocesses, with the same answers and the
same `problem` messages. Every CLI gate and every dashboard detail poll inspects the worktree, so
production calls gain the same two processes. Vitest's worker count was measured and left alone: 6 workers instead of the
default 11 cut the summed file time from 4879–5721 s to 4095 s (less thrash) but the wall clock
stayed at 924 s, because `tests/ci.test.ts` alone took 922 s; a setting that only helps the
cores other work needs is not worth a config line that CI (2 cores) would have to be told to
ignore.

**Not changed, and why.** The remaining 3 processes per inspection (`rev-list --left-right`,
`log`, `diff --name-status` against the base) are needed by the plan and the sensitive-path
report but not by most gates; making them lazy would save another ~20% but turns plain fields
into getters that spawn on access, which a spread copies eagerly and a reader at 3 a.m. does not
expect. Splitting `tests/ci.test.ts` is the next lever for the wall clock (it is the critical path
locally and on CI), but PR A of this phase adds to that file, so the split waits for it to merge.
Reusing one Git repository across tests was rejected: the tests mutate their repositories, and a
shared mutable fixture is the flake the suite was just cured of.

**E04, the dashboard.** With 8 jobs on the board, one of them a real worktree with 45 registered
artifacts (2 MB) and a 5 MB unregistered CI log: `board()` 2 ms per poll; `detail()` of a seeded
job without a worktree 70–160 ms; `detail()` of the worktree job 1.0–2.2 s, of which reading the
2 MB of artifacts is 11–18 ms (1%) and `planJob` is the rest: `worktreeOf` about 60% (the Git
inspection above), `effectivePolicy` 20% (`merge-base` and `show`), `dirtyFiles` of the checkout
and `verificationStatus` about 6% each. The artifact-reread hypothesis is refuted; the detail
poll's cost is the Git-derived plan, and it benefits from the `rev-parse` change. No cache was
added: a correct key needs the worktree HEAD and status, which are themselves Git calls, and one
open detail page costing a fraction of a core every 4 s is not the bottleneck of a factory run.

**E05, leaked fixtures.** One full run at `main` left 14 and 49 temporary directories behind
(`orch-a-`, `orch-gone-`, `orch-other-`, `orch-replaced-`, `orch-init-home-`, `orch-doctor-`,
`orch-ci-cwd-`, `orch-gh-shim-`, plus `orch-test-`, `orch-repo-`, `orch-bare-` from tests whose
cleanup was skipped by an earlier failure or refused by a Windows handle). Each is a `tempDir()`
call without a matching removal. Phase 2 (PR #13) fixes it at the root: `tempDir()` records every
directory it creates and a Vitest setup file removes what a file left behind when it finishes.
Phase 4 wrote the same fix independently and validated the approach before finding #13: with
`TEMP` pointed at a private directory (other sessions were running the suite in the shared one),
the leak-prone files left nothing behind; the duplicate was dropped in favour of #13.
