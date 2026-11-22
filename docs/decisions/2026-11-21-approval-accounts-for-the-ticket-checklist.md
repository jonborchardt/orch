# Approval accounts for the ticket checklist (ticket 0114)

**Decision.** A factory job linked to a ticket completes `approve` only when every unchecked box in
the ticket body is either ticked in the ticket or recorded as not delivered in the registered
`decision.md`: a `- [ ] <item> — <reason>` line under `## Ticket checklist`, item text exactly as
in the ticket, a non-empty reason after the em dash (space, U+2014, space). The rule is `unaccountedItems` in
`src/core/tickets.ts`, enforced in `transitionGuarded` (`src/ops/gates.ts`) for open or
in-progress tickets with an APPROVE decision. The approver writes the section (`- [x] <item> —
<evidence>` for delivered boxes, prose only); the factory session ticks the delivered boxes with
`orch ticket edit` and copies each reason with `orch ticket note` (best effort, not checked). The
merge rule (`mergeDecision`, `settleTicketForMerge`) is unchanged: an undelivered box keeps the
ticket in progress after the merge.

**Why.** A verified merge closes a ticket only when no box is unchecked, and only `/dotodo` step 4
ticked boxes, so every controller run (`orch start`, `orch do`) over a ticket with a checklist
merged and then stopped blocked (ticket 0106, PR 112). The approver is the one who already holds
the acceptance evidence, and `approve` is the last stage that judges the code, so the boxes are
accounted for there. orch does not tick boxes itself: whether a box was delivered is a judgement,
and the gate only checks that every box was judged.

**Alternatives not taken.** Enforcing at `pr` completion or in `mergeJob` comes after the evidence
and widens the merge rule. A required heading in `core/artifact-rules.ts` cannot know about
tickets. Fuzzy matching of items would let a paraphrase pass; the exact match fails closed and the
refusal names the line to copy. Jobs approved before this rule get no ticking; dotodo step 4 and
`orch ticket edit` plus `orch job merge` remain the manual remedy.
