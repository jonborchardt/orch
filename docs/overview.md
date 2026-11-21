# How it fits together

`orch` has three parts that hand work to each other: a **ticket queue** (what there is to do), the
**factory** (one attempt to do it, ending in a pull request whose checks pass), and the **merge**
(getting that pull request into the base branch and closing the ticket). This page explains how
they connect, and how the ticket queue compares with [Beads](https://github.com/steveyegge/beads),
the issue tracker its model borrows from.

The details live elsewhere: [tickets.md](tickets.md) for the queue,
[workflow.md](workflow.md) for stages, gates, and merging, [dashboard.md](dashboard.md) for the UI.

## The three parts

| part    | unit   | answers                              | commands                                |
| ------- | ------ | ------------------------------------ | --------------------------------------- |
| Tickets | ticket | what is there to do, and what first? | `orch ticket ...`, `/log-todo`          |
| Factory | job    | is this change built and checked?    | `orch factory ...`, `/factory`          |
| Merge   | job    | is it in the base branch?            | `orch job merge`, the dashboard's Merge |

All three keep their state in one SQLite database in your user data directory. Nothing is written
into a repository, nothing synchronises, and nothing runs in the background unless you start the
dashboard or the recovery worker.

- A **ticket** is a thing to do: a bug, a feature, a chore, or a question. It belongs to one
  repository, but the queue is global, so priorities and dependencies compare across repositories.
- A **job** is one attempt at a change in one repository. It may be linked to a ticket or stand
  alone. A ticket can have several jobs over time (a cancelled attempt, a re-land), but only one
  unfinished job at once.
- A **merge** is not a stage. A job is `completed` when its PR is ready and its required checks
  pass on GitHub; merging happens after that and is recorded on the completed job.

## The life of a ticket

```
orch ticket add            ticket: open
        │
orch ticket ready          open, not a question, dependencies done, no unfinished job,
        │                  repository checkout present
        │
orch factory start         job created; in the same transaction the ticket becomes
  --ticket <id>            in-progress and is linked to the job
        │
/factory                   spec → build → simplify → review → approve → pr → ci
        │                  every stage gated by orch on a validated artifact and a
        │                  verification run for the exact commit
        │
job completed              PR ready for review, GitHub's required checks passed on ciHead
        │                  the ticket is still in-progress
        │
orch job merge <job>       reads the PR fresh, merges exactly ciHead as a merge commit,
  or dashboard Merge       reads GitHub again to confirm, records the merge commit
        │
ticket: done               in the same transaction as the merge record, when the merged
                           head is the verified one and no `- [ ]` item is left
```

What can interrupt that path:

- **The PR conflicts with the base.** `orch job merge` creates one re-land job on the same ticket
  and marks the old job superseded. The re-land runs the factory again. If it conflicts too,
  nothing more is created and a person decides.
- **The ticket has unchecked checklist items.** The merge is recorded and the ticket stays
  in-progress, with the reason noted once. Tick what was delivered and run `orch job merge` again,
  or close it with `orch ticket done`.
- **GitHub merged a different head than CI passed on.** The merge is recorded as
  `verified: false`, the ticket stays open, and the command exits 1.
- **The repository is not opted in.** `orch job merge` refuses (`not-authorized`). The dashboard's
  Merge still works, because a click is a person's decision.

The `/dotodo` skill is this whole path as one instruction: start the factory for a ticket, tick the
delivered boxes, call `orch job merge`, and report. It adds no rules of its own.

## Who decides what

The split is the same in every part: rules that matter are TypeScript, checked in a database
transaction; Claude sessions do the creative work and call the CLI.

| decision                                | made by                                               |
| --------------------------------------- | ----------------------------------------------------- |
| which ticket to work on                 | you (`orch ticket ready` proposes an order)           |
| whether a ticket can have a job now     | `createJob`'s transaction and a unique index          |
| whether a stage is complete             | `orch`, from artifacts and verification runs          |
| whether the PR's checks passed          | GitHub, read by `orch gh ci` for the exact head       |
| whether programmatic merging is allowed | you, per repository (`orch factory config merge`)     |
| whether this PR may merge now           | `mergeDecision`, from the job and GitHub's fresh PR   |
| whether the merge happened              | GitHub, read again after the merge command            |
| whether the ticket is done              | the merge transaction, or you with `orch ticket done` |

## Compared with Beads

Beads (`bd`) is a dependency-aware issue tracker built for AI agents. `orch` took its model of
tickets, dependencies, readiness, and claiming from it, and none of its code. The exact functions
that were read are listed in
[decisions/2026-11-20-global-ticket-queue.md](decisions/2026-11-20-global-ticket-queue.md) (Beads
at commit `7862410`). The description of Beads below is from its README and docs as read on
2026-11-20; Beads changes quickly, so check it before relying on a detail.

### What is the same

| idea                                    | in Beads                                               | in orch                                                    |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Work is a graph, not a list             | issues with typed dependencies                         | tickets with `ticket_links(ticketId, targetId, kind)`      |
| Only some links block                   | `blocks` and three others block; `related` etc. do not | `depends_on` blocks; `related` does not                    |
| Cycles are refused when a link is added | checked at write time                                  | `dependencyPath`, inside the write transaction             |
| "Ready" is computed                     | `bd ready`: no open blocking dependency                | `orch ticket ready`: the same, plus the conditions below   |
| Claiming is atomic                      | `bd update --claim` sets assignee and in-progress      | creating the job marks the ticket in-progress and links it |
| Every change is in a history            | an events table with old and new values                | `ticket_events` with `from` and `to`                       |
| The database is the source of truth     | the local Dolt database; JSONL is only an export       | the local SQLite database; there is no export              |

### What is different, and why

| topic             | Beads                                                                               | orch                                                                                           | why                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope             | one database per project, in `.beads/`; cross-project links are an extra feature    | one queue for every repository on the machine                                                  | The question orch needs answered is "what next, across all my repositories", and one queue makes priorities and dependencies directly comparable |
| Where data lives  | in or beside the repository, shared through a Dolt remote (can be the git `origin`) | the per-user data directory; never in a repository                                             | orch is one person's machine. Nothing to sync means nothing to merge or conflict, and no ticket leaks into a shared repository                   |
| Storage           | Dolt, a version-controlled SQL database with cell-level merge                       | SQLite through Node's built-in driver                                                          | A single local writer needs transactions, not distributed merge. It is also the database jobs already use                                        |
| Ids               | hash ids (`bd-a1b2`), unique without coordination; `bd-a1b2.1` for children         | one counter (`0085`), never reused                                                             | Hash ids solve offline collisions between machines. With one database a counter is safe, shorter, and was already in use                         |
| Hierarchy         | epics, parent-child, up to three levels                                             | none                                                                                           | A ticket is sized to be one job. Bigger work is several tickets with dependencies                                                                |
| Dependency kinds  | four that block, several that annotate                                              | one that blocks, one that annotates, plus `duplicate`                                          | No second use yet for conditional or waits-for links                                                                                             |
| Blocked state     | maintained on the issue as a flag                                                   | derived on every read, with a reason per ticket                                                | The queue is hundreds of rows. Computing on read cannot go stale                                                                                 |
| Readiness         | no open blocking dependency (plus deferral)                                         | also: not a question, no unfinished job, repository checkout exists                            | Ready here means "a factory job could start now", not only "nothing blocks it"                                                                   |
| What a claim is   | an assignee and a status on the issue                                               | a job row; the job's lease is the worker's lease                                               | The job already records who is working and whether they are alive. A second claim mechanism would have to agree with it                          |
| Who does the work | not Beads' concern: any agent that reads `bd ready`                                 | the factory, with gated stages and executed verification                                       | orch exists to run and check the work. The tracker is one part of it                                                                             |
| Closing           | the agent runs `bd close`; "issue state is decoupled from code state"               | a verified merge closes the ticket in the transaction that records it, or you close it by hand | An agent saying "done" is a claim. orch closes on evidence: GitHub merged the commit its checks passed on                                        |
| Waiting on a PR   | optional gate issues (`gh:pr`, `gh:run`) that block other issues until resolved     | built in: the job's `ci` stage and `orch job merge`                                            | The PR belongs to the job, so its state is read for that job rather than modelled as another issue                                               |
| Multiple agents   | concurrent writers through a Dolt server; federation between machines               | one machine; SQLite immediate transactions and one unique index                                | Out of scope by design                                                                                                                           |
| Extras            | memory, compaction, messaging, formulas and molecules, GitHub/Jira/Linear sync      | none of these                                                                                  | Not needed to queue work for the factory                                                                                                         |

### The short version

Beads is a tracker you give to agents: it is distributed, lives with the project, and trusts the
agent to say when work is done. `orch`'s tickets are a queue for one person's factory: local,
global across repositories, and closed by proof of a merge. The graph model (typed links, cycle
checks, computed readiness, atomic claims, a history) is shared; almost everything about storage,
distribution, and what "done" means is not.

If you need tickets shared between people or machines, an issue hierarchy, or a tracker that works
without the factory, Beads is the better fit. `orch` does not try to cover that.

## What is not built

Nothing picks a ticket and starts a job on its own: there is no `orch start`, no scheduler, and no
merge queue. Each step above is one command that someone, or a skill, runs. Nothing runs on the
merged result either: "verified" means GitHub merged the commit that passed its checks.
