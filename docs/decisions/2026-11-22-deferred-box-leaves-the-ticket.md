# A box deferred to a follow-up ticket leaves the original (ticket 0117)

**Decision.** A checklist box handed to a follow-up ticket is recorded in `decision.md` under
`## Ticket checklist` as `- [ ] <item> — deferred to <key>[: <why>]`: the reason starts with
exactly `deferred to` and a ticket id (`0116`, `#116`, `116`). `deferredItems` in
`src/core/tickets.ts` reads those lines; `requireChecklistAccounted` in `src/ops/gates.ts` refuses
to complete `approve` while a deferred item is still an unchecked box in the ticket body, while the
follow-up is missing, is this ticket, or is not open or in progress, or while no `ticket.note` on
the ticket contains the follow-up's key. These checks run even when no box remains in the body.
The factory session removes the box (or rewrites it as plain text) with `orch ticket edit` and
writes the note with `orch ticket note`. The merge rule (`mergeDecision`, `settleTicketForMerge`)
is unchanged: with the box gone, the verified merge closes the ticket, and a follow-up that
depends on it becomes ready.

**Why.** A box left unchecked keeps the ticket open after its merge, and a follow-up that depends
on it cannot start, so an unattended `orch start` run stopped until a person closed the original by
hand (ticket 0115, PR 118). The hand-off is a judgement the session makes; orch only checks that it
was carried out completely and points at a ticket that will do the work.

**Alternatives not taken.** Treating any ticket key in a reason as a deferral would misfire on
numbers such as years; the fixed phrase fails closed to today's behaviour. orch editing the body or
writing the note itself would have orch tick or remove boxes, which decision
2026-11-21-approval-accounts-for-the-ticket-checklist keeps a session's job. Requiring the
follow-up to depend on the original, or to carry the box in its body, is not checked; the note
substring match is weak evidence but proves the hand-off was recorded on the ticket.
