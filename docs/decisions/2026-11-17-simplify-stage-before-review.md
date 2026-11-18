# Simplify stage before review

**Decision.** A `simplify` stage sits between `build` and `review`, and every completed build
enters it (first build, review rework, CI repair, base-integration rework). The read-only
`factory-simplifier` (role `simplifier`, Sonnet) writes `round-N/simplify-review.md` (`Findings`)
about over-engineering in the diff; `factory-builder` applies what makes sense and writes
`round-N/simplify.md` (`Applied`, `Declined` with reasons, `Validation`). `transition()` refuses
`complete` without both files. `simplify.md` is code evidence in `ops/gates.ts`: registered from a
clean worktree with its HEAD, and completion needs HEAD unchanged and verified. Review verdicts
must describe the HEAD of the current round's `simplify.md`, or `build.md`'s when the round has
none (legacy jobs, `request-review`, `resume --to review`). The round still increments when build
completes, so the simplify pass belongs to the review round that follows it.

**Why.** Builders tend to add more than the spec needs, and reviewers judge correctness rather than
size. A separate pass with its own rules, before reviewers spend a round, removes code while it is
cheap to remove. Two files keep the simplifier read-only and make the builder answer each finding.
The rules live in the agent file, not in the ponytail plugin, since the factory cannot assume a
plugin is installed.

**Limits.** The simplifier's read-only rule is its tool list and prose; `check-readonly` does not
run for it. A `request-review` or `resume --to review` after simplify committed a fix compares
verdicts to `build.md`'s older head and is refused; a human uses `request-rework` instead. The
stage costs one more agent run per round and cannot be switched off.
