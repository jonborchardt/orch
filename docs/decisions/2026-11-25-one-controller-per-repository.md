# One factory controller per repository

Ticket 0163. Supersedes the "one headless child at a time" part of
[2026-11-21-foreground-factory-runner](2026-11-21-foreground-factory-runner.md), and its "more
than one ticket at a time" exclusion, with "one per repository". Everything else in that decision
stands: foreground, started by a person, gone when its command exits, one headless
`claude -p "/factory <job>"` child per controller, no messages, no supervisor.

**Decision.** The controller lock is per repository. `orch start --repo A` and
`orch start --repo B` run in two terminals at once, each one ticket at a time. Two controllers
never cover the same repository, and a controller for the whole queue (`orch start`) runs alone.

- **Slot.** Each scope has a slot: lock generations, session record, two stop files, each file
  with one writer, as before. The unscoped slot ("every repository") is the files at the data
  root, whatever an older `orch` left there. A repository's slot is the same files plus
  `scope.json` under `<data>/runners/<key>/` (`runnerPaths(paths, key)`).
- **Scope identity** is decided in one place, `runnerScope` in `src/ops/repo.ts`: the remote
  identity when the repository has one, else its canonical Git common directory; the key is a
  short hash of that name. Two clones of one remote, and a checkout and its linked worktrees,
  share a slot. `orch do <ticket>` takes the slot of its ticket's repository
  (`ticketRunnerScope`).
- **Overlap** (`scopesOverlap`): two slots overlap when either is the unscoped one, or both
  recorded the same common directory. The second case keeps one checkout one scope when its
  `origin` is added, removed, or re-pointed while a controller or an interrupted session exists.
- **Admission.** A starter claims the next generation in its own slot by exclusive creation, as
  before, records its scope, and only then looks at every overlapping slot. If one has a live
  holder or an unfinished session, it gives its generation back and is refused. Two overlapping
  starters racing may both be refused; both are never admitted. A single admitted winner would
  need a real mutex across slots, which is not worth having for a person starting two terminals.
- **Stop and resume** act on the one live controller, else the one interrupted session; with
  several they exit 2 and list them, and `--repo <path>` names one.
- **Status** (`orch status`, `GET /api/runner`) lists every open slot. The dashboard still starts,
  stops, and resumes nothing.

**Why this fits the positioning.**
[2026-11-24-positioning-and-non-goals](2026-11-24-positioning-and-non-goals.md) declines parallel
throughput because one ticket at a time keeps evidence pinned to one head. That head is a base
branch of one repository. Two tickets in one repository move the same base under each other: the
second merge lands on a head the first one's evidence never saw. Two repositories have no head in
common, so they cannot conflict with each other, and "evidence pinned to one head" holds for each
of them exactly as it did. Serial within a repository, parallel across repositories gives up
nothing the non-goal protects.

**What it does not allow.** Two controllers on one repository; more than one ticket at a time in
one controller; a controller started by the dashboard or by another controller; a supervisor
process. The verification queue stays machine-wide and serial
([2026-11-16-verify-runs-one-at-a-time](2026-11-16-verify-runs-one-at-a-time.md)).

**Costs a person should know.**

- Both controllers use one Claude account, so a long run reaches its usage limit sooner. Each
  controller then ends its own run resumably
  ([2026-11-24-usage-limit-ends-run-resumably](2026-11-24-usage-limit-ends-run-resumably.md)).
- Ticket priority is per repository: a lower-priority ticket in one repository can run while a
  higher one waits in the other.
- Every controller's gates run the installed build. Rebuilding `dist/` (from `main` only) while
  any controller runs changes the gates under it and halts each of them (`orch-rebuilt`), now
  possibly two at once. It matters most when one controller works on the `orch` repository.
- Builder and reviewer runs of the two repositories overlap, so machine load grows;
  verifications still run one at a time.
- A clone without `origin` next to a separate clone that has one are two scopes (different keys,
  different common directories). The queue filter gives them different tickets, so their
  controllers never take the same one.
- Both controllers lease jobs as `orch-runner`. That is safe only because admitted slots never
  overlap.
- Lock generations are still never pruned, and the root files are not moved.
