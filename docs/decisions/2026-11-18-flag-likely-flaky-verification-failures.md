# Flag likely flaky verification failures

**Decision.** After `orch verify` finishes a run, `src/ops/verify.ts` labels a failed run a likely
flake with a `verification.flaky` event when either (a) a later run of the job at the same tree and
policy passes (`passed-on-rerun`), or (b) every failing test that the first failed required
check's saved log names is in a file the job did not change (`unchanged-file`). Failing tests come
from Vitest ` FAIL  <file> > ...` lines in that log, parsed by the pure `src/core/flake.ts` with
paths joined to the check's `cwd` and compared worktree-relative; an absolute or escaping path
counts as changed. A run is flagged at most once (`markFlaky` reads the job's existing flags in its
transaction). The newest flag shows on the board, in the job detail, as `plan.flake` and a `Flaky:`
line in `orch factory status`, while the job is not finished; `verification.flaky` is mailed.

**Why.** An unrelated flaky test (`web/src/App.test.tsx` "shows Refreshing") failed runs in at least
four jobs overnight; builders reran verify and nobody was told, which looked like hours without
progress. A human needs to see that a test the job never touched is costing reruns.

**Why this parses logs although decision 58 rejected it.** Decision 58 rejected classifying a CI
`failure` as flaky from its log because the classification would decide what happens next (a
re-run instead of a repair) on a guessed signature. Here the result is a label for a human, never a
verdict: it changes no run status, no validity, no gate, no retry, and no transition, the same way
`core/sensitive.ts` only labels. The parser reads one well-defined summary line format, and when
the format is absent the label names the check instead (rule a) or is not given (rule b).

**Limits.** Rule (b) can call a real regression "likely flaky" when a change breaks a test file it
did not touch; the wording stays "likely", and the verification blocker still shows. Rule (a)
needs an identical tree, which builders rarely rerun. Only Vitest output is read, only the first
failed required check, and only what survived the log cap (the summary is at the tail). There is
no dismissal and no cross-job aggregation.
