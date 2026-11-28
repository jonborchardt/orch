# A merged ticket with unticked boxes is finished by one of three ticket actions

**Decision.** A ticket whose PR merged while checklist boxes stayed unticked (the controller's
`ticket-open` stop) is finished by one of three operations, each one revision-checked
transaction in `src/storage/tickets.ts`, reached through `ticketAction` in `src/ops/tickets.ts`
by both `orch ticket` and `POST /api/tickets/<id>/actions` (ticket 0218):

- `split` (`orch ticket split`, `splitTicket`): file a follow-up ticket holding the chosen
  unticked boxes, tick them on the original as `(moved to NNNN)`, and close the original as done.
  `hold` files the follow-up as a `question`, which no controller picks up.
- `done` with `tickAll` (`orch ticket done --tick-all`): tick every unticked box and close.
- `reopen` (rework): the ticket is open again and gets a new job the way any open ticket does,
  from `orch start` or `orch do`.

`showTicket` reports what is left as `finish` (the boxes and the merged job's `## Known gaps`),
the job detail carries the same view for the merged job, and the ticket page offers the
operations as confirmed buttons. The controller's `ticket-open` next step and the status mail of
that job print one link per option, `http://127.0.0.1:4777/#/tickets/NNNN?finish=split|close|rework`
(`finishLines`), beside the equivalent command. The link is a hash route that only opens that
option's confirm, as `?choose=` does (decision 2026-11-26-choose-link-opens-a-confirm).

Boxes are numbered 1..n in the order the unticked boxes appear in the body. The follow-up's title
(`Follow-up of NNNN: <title>`) and effort (the default) are not asked for; they are edited on
the follow-up like any ticket's.

**Why.** Finishing such a ticket took a terminal session: edit the body from stdin, file a ticket
by hand, link it, close the first. Each step could be forgotten, and between steps the queue
showed a half-finished state. One transaction per choice removes both. The follow-up reuses
`createTicket`'s insert inside the split transaction, so a refused split (stale revision, invalid
area, a job at work, a bad box number) leaves no ticket behind.

Ticket writes from the dashboard keep their one entry point, `ticketAction`; they do not go
through `src/ops/actions.ts`, which is the job action module. Rework creates no job from the
click: no route starts the controller, and a job is linked to a ticket only through `createJob`.
Merge rules, `settleTicketForMerge`, and the approval checklist gates are unchanged: a merge still
never closes a ticket with a box unticked, and nothing here judges whether the merged code covered
a box. A person does, with one click per choice.
