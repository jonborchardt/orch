# Spec challenger gates the spec

**Decision.** The `spec` stage needs an independent challenge before `build`. The
`factory-spec-challenger` subagent (role `spec-challenger`, Sonnet) writes `spec-review-1.md` and,
after one revision of `spec.md`, `spec-review-2.md`; each carries `Findings` and one
`VERDICT: PASS|CHANGES` line. Registering a challenge records the sha256 of the `spec.md`
registered at that moment on the artifact row (column `specSha256`). The pure rule
`specChallengeRefusal` in `src/core/workflow.ts` refuses `complete` from `spec`, and `resume` from a
spec escalation to any other stage, unless the highest-numbered challenge is a PASS bound to the
current `spec.md` hash. A second CHANGES is planned as the existing `escalate`; there is no new
stage, action, or `reviews` row.

**Why.** A spec that misses behaviour or inverts the request costs a whole build and review cycle
to discover. Gating in `transition()` covers the CLI, the dashboard, and recovery alike. A column
binds the PASS to the exact spec without asking a model to copy a 64-character hash into its file;
replacing `spec.md` makes an earlier PASS stale, and re-registering an unchanged challenge for a
newer spec needs `--replace`, so the rebinding is logged.

**Limits.** The "revise once, then escalate" bound is cooperative: the plan stops after
`spec-review-2.md`, but `--replace` on it (how a human-resumed spec is re-challenged) is not
capped in code, so a misbehaving coordinator could loop. Correctness still holds, since a PASS
must match the current spec; only cost is unbounded. Code cannot prove the challenger ran as a
separate subagent; that is the same trust as for code reviewers.
