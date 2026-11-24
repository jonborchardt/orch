# Explicit ticket order is a fractional rank on the ticket

**Decision.** A person orders the queue through `tickets.rank`, a nullable `REAL`, lowest first,
global like ids. `orderTickets` in `src/core/tickets.ts` keeps Kahn's algorithm and picks among
free tickets by effective rank (the lowest rank among the ticket and its open transitive
dependents), then own rank, then priority, effort, area, id; unranked sorts after ranked. With no
rank set the order is the old one. `orch ticket move` (and the dashboard's Up, Down, Top) is the
pure `planMove`, applied by `moveTicket` in one transaction: the moved ticket's rank falls between
its new neighbours, every ticket above it is ranked, and a move that would pass a dependency is
refused. Each write is a `ticket.rank-changed` event.

**Why.** A fraction makes "put before" one row write in the common case, with no renumbering by
hand. Integers with gaps need occasional renumbering of other tickets; a linked list makes the
order query harder. The effective rank keeps a ranked ticket from being buried behind an unranked
dependency, also when the rank is set with `edit --rank`, which ranking the chain inside `move`
would not cover. Ceiling: repeated inserts at one spot halve the gap, and doubles run out after
about 50; renumbering the ranked tickets is the upgrade path, not built.
