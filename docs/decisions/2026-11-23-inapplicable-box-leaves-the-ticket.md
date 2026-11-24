# A box that does not apply leaves the ticket, approver-confirmed (ticket 0128)

**Decision.** A checklist box the PR shows does not apply (its condition is false, its branch was
not taken) is recorded in the approver's `decision.md` under `## Ticket checklist` as
`- [ ] <item> — does not apply: <why>`: the reason starts with exactly `does not apply:` and the
why is non-empty. `inapplicableItems` in `src/core/tickets.ts` reads those lines;
`requireChecklistAccounted` in `src/ops/gates.ts` refuses to complete `approve` while such an item
is still an unchecked box in the ticket body, or while no `ticket.note` on the ticket contains
`<item>: does not apply`, also when no box remains. The factory session removes the box with
`orch ticket edit` and writes the note with `orch ticket note`; the merge rule is unchanged, so the
verified merge closes the ticket. `log-todo` writes one box for an either/or decision instead of
one per branch.

**Why.** An either/or checklist kept its ticket open after a merge that took one branch (ticket
0094): the other box could only be left unchecked with a reason, which stops the queue like the
undeferred box of decision 2026-11-22-deferred-box-leaves-the-ticket. The why is required because,
unlike a deferral, no follow-up ticket carries the explanation. The approver's artifact is the
only thing that permits the removal, so a session cannot drop a box that is simply not done.

**Alternatives not taken.** Treating any free-form reason as permission to remove the box would
let undone work close a ticket; the fixed phrase fails closed to today's behaviour. orch editing
the body or writing the note itself would have orch remove boxes, which decision
2026-11-21-approval-accounts-for-the-ticket-checklist keeps a session's job.
