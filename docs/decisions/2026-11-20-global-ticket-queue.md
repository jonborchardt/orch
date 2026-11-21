# Tickets are one global queue in the job database

**Decision.** Tickets are rows in the shared SQLite database (`tickets`, `ticket_links`,
`ticket_events`, `ticket_areas`), numbered by one global `AUTOINCREMENT` sequence, each recording
its repository the way a job does. A job points at its ticket with a nullable `jobs.ticketId`; a
partial unique index allows one unfinished job per ticket, and the claim (check, mark in progress,
link) happens in the transaction that inserts the job (`orch factory start|dispatch --ticket`).
Readiness is computed on read from statuses, links, and jobs; nothing stores "blocked". The private
Markdown register and its index script are retired; `orch ticket import` moves a register in once.

**Why.** One queue lets priorities and dependencies be compared across repositories, which the
future scheduler needs. Putting it next to jobs lets a database constraint, not a check-then-insert
across transactions (the weakness of issue de-duplication in `dispatchJob`), prevent two jobs for
one ticket. A separate history table keeps ticket events from needing a job id or cascading with
one.

**Taken from Beads** (`steveyegge/beads` at `7862410`; concepts only, no code or dependency):

- Dependencies as rows with a kind, where only some kinds block: the `dependencies` table and
  `DependencyType.AffectsReadyWork` in `internal/types/types.go`. Here
  `ticket_links(ticketId, targetId, kind)` with `depends_on` blocking and `related` not.
- Cycle prevention at the moment a dependency is added, by reachability from the target back to
  the source: `WouldCreateSchedulingCycleInTx` in `internal/storage/issueops/dependencies.go`. Here
  `dependencyPath` in `src/core/tickets.ts`, run inside the write transaction.
- A ready query that is a plain filter plus a deterministic sort: `BuildReadyWorkWhere` and
  `BuildReadyWorkOrder` (the `priority` policy: priority, then age, then id) in
  `internal/storage/sqlbuild/ready.go`. Here the order of the old index script was kept instead
  (dependencies, priority, effort, area, id), because it already existed and was tested.
- Claiming as a compare-and-swap inside one transaction that also sets in-progress:
  `claimIssueInTx` in `internal/storage/issueops/claim.go`. Here the immediate transaction in
  `createJob` plus the unique index; the job's existing lease is the worker lease.
- An events table with old and new values per change: the `events` table (`old_value`,
  `new_value`) and `RecordFullEventInTable`. Here `ticket_events` with a JSON payload carrying
  `from` and `to`.

**Deliberately not taken.** Hash ids (a single local writer does not need collision-free offline
ids; a counter is readable and was already in use). The materialized `is_blocked` column and its
incremental maintenance (the queue is a few hundred rows; computing on read cannot go stale). Dolt,
JSONL and Git synchronisation, the daemon, leases on issues, parent-child hierarchies and epics,
conditional and waits-for dependencies, deferral, pinned and ephemeral issues, labels, agent
memory, and the hybrid age-based sort.

**Deviations from the request that asked for this.**

- Imported notes stay inside the ticket body rather than becoming history rows: the body is stored
  whole, so nothing is lost or reordered, and parsing free-form notes into events could. New notes
  are history rows (`ticket.note`).
- A colliding register is remapped as a whole, not ticket by ticket, so one register never ends up
  with a mix of kept and changed ids.
- The HTTP API does not create jobs for tickets or accept asset uploads; both are CLI only, which
  keeps the server from taking file paths to read.
- There is no Markdown export.
- `done`, `drop`, and `duplicate` are refused while an unfinished job is linked, in addition to the
  one-job rule.
