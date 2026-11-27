# A third spec challenge slot: two automatic revisions

**Decision.** The spec challenge has three slots, `spec-review-1.md` to `spec-review-3.md`
(ticket 0176). Slot N > 1 is accepted only when slot N-1 says CHANGES; `spec-review-4.md` and
higher are refused. A CHANGES in slot 1 or 2 makes the plan revise `spec.md` and challenge again;
a CHANGES in slot 3 escalates ("spec challenger requested changes three times; see
spec-review-3.md") with the same human steps as before. The slot rule is `challengeSlot` and
`challengeSpecHash` in `src/core/workflow.ts` (`LAST_CHALLENGE_SLOT`); `src/ops/factory.ts` only
turns it into plan steps. This replaces the "revise once" bound of
[2026-11-17-spec-challenger-gates-the-spec](2026-11-17-spec-challenger-gates-the-spec.md); its
other rules stand.

**Why.** A second CHANGES often carried a written correction a person only had to paste in
(job-73f5b20c waited three hours for that). One more automatic revision interrupts the person
less without weakening the gate: the challenger must still say PASS for the current `spec.md`, and
nothing judges whether a finding is "concrete"; the count is the only rule.

**Limits.** The bound is still the plan's, not a code cap: `--replace` re-challenges in the
highest slot are not counted, as before. Jobs are not told apart by when they escalated; a job
that escalated after review 2 and is resumed at `spec` follows the three-slot rule from there.
