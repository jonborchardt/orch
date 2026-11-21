# How it fits together

`orch` has three parts that hand work to each other: a **ticket queue** (what there is to do), the
**factory** (one attempt to do it, ending in a pull request whose checks pass), and the **merge**
(getting that pull request into the base branch and closing the ticket). This page explains how
they connect, how the ticket queue compares with [Beads](https://github.com/steveyegge/beads),
the issue tracker its model borrows from, and how the merge and the unattended controller compare
with agent-orchestrator and Gas Town.

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

## Compared with agent-orchestrator and Gas Town

Two other projects run coding agents and get their work merged:
[agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) (AO) and
[Gas Town](https://github.com/gastownhall/gastown). `orch`'s merge took three ideas from them and
no code; the exact functions are listed in
[decisions/2026-11-20-orch-job-merge.md](decisions/2026-11-20-orch-job-merge.md). The controller
(`orch start`) took nothing from either: it was designed from `orch`'s own pieces, and this
comparison was written afterwards.

What follows is from their source as read on 2026-11-20, AO at commit `7919c96` (backend and docs
only) and Gas Town at `94cc822`. Both change quickly, so check them before relying on a detail.
One thing to know about Gas Town at that commit: its README and design docs describe a strict Go
merge engine (commit-pinned re-checks, a merge-slot lock, batch-then-bisect), and that engine is in
the tree, but nothing outside its own package and tests calls it. The path that runs is an agent
following a written procedure, and that is what the tables describe.

### What is the same

| idea                                         | in AO                                                                | in Gas Town                                                    | in orch                                                           |
| -------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| One worktree and branch per unit of work     | a session's worktree                                                 | a worker's worktree                                            | a job's worktree                                                  |
| Merge only the commit that was looked at     | the caller's expected head against the stored, fresh, and CI heads   | proof afterwards that the target contains the submitted commit | `gh pr merge --match-head-commit <ciHead>`                        |
| Unknown is not ready                         | pending or unknown CI blocks; mergeability must be exactly mergeable | (no equivalent on the running path)                            | `UNKNOWN` mergeability is `waiting`, never a merge                |
| Prove the merge, then close the work         | (the provider's answer is taken as proof)                            | `gt mq post-merge`: prove, close the request, close the issue  | read the PR again; record and close the ticket only when `MERGED` |
| Every step tolerates "already done"          | a merge made elsewhere is picked up by the next poll                 | each close accepts an already-closed item                      | `already_merged` records what GitHub did and merges nothing       |
| The agent that merges never fixes a conflict | the owning worker is told to rebase                                  | the merging agent hands a task to a worker                     | a new job re-lands the work                                       |
| Uncommitted work is never thrown away        | a dirty worktree is not removed                                      | workers with uncommitted work are skipped on shutdown          | nothing in `ops/` deletes uncommitted work                        |

### Merging: what is different, and why

| topic               | AO                                                                                                           | Gas Town                                                                                                                         | orch                                                                                                                   | why                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Who merges          | a person asks (the app, or `ao pr merge`); a ready PR only raises a notification                             | a dedicated agent session per repository, running `git` and `gh` itself from a written procedure                                 | one deterministic operation, `mergeJob`, behind the dashboard button, `orch job merge`, and the controller             | A rule that matters is enforced in code. An unattended run cannot wait for a click, and a procedure an agent reads is not a gate |
| Permission to do so | nothing merges automatically, so there is no setting                                                         | automatic once a repository is added; a required review is opt-in                                                                | off until `orch factory config merge enable` for that repository; a dashboard click needs no opt-in                    | "Humans merge" stays true everywhere the user has not said otherwise                                                             |
| Evidence required   | a fresh read of GitHub: checks passing for that head, no changes requested, no unresolved comment, mergeable | a rehearsal merge and the repository's commands, run locally by the agent, which may merge past a failure it judges pre-existing | the job completed on GitHub's passing verdict for one commit, after `orch` ran the checks and the reviews and approval | Evidence here is executed by `orch` and bound to a commit before the merge is even asked for; nothing is judged at merge time    |
| Merge method        | squash by default; merge or rebase on request                                                                | a merge commit pushed straight to the target branch; a PR merge only in its PR mode                                              | a merge commit of the PR, never squash or rebase                                                                       | The verified commit itself must end up in the base. A squash or rebase lands a commit nobody checked                             |
| After the merge     | the provider's response is recorded; a failed local write is repaired by the next poll                       | a deterministic command proves the commit is in the target, then closes                                                          | the PR is read again whatever `gh` exited with; one transaction records it and closes the ticket                       | A timeout after a successful merge is a success, and a crash before the write is repaired by calling again                       |
| A conflict          | the worker is messaged once to rebase; its branch goes on                                                    | a worker resolves on the same branch; its tests and the next rehearsal check it                                                  | one re-land job through every stage; the old job is superseded; a second conflict stops                                | A resolution is new code, so it gets the same specification, verification, and review, and it is bounded                         |
| Queue               | none; GitHub's compare-and-swap, and GitHub's merge queue for stacked PRs                                    | requests scored by priority and age, one merging agent per repository                                                            | none                                                                                                                   | The controller runs one ticket at a time and each merge is pinned at GitHub; a queue would guard nothing                         |
| The work item       | the tracker issue is never closed or commented on                                                            | the source issue is closed once the merge is proved                                                                              | the ticket closes only on a verified merge with no unchecked box left                                                  | Closing is a claim about the work, so it needs the same proof as the merge                                                       |

### Running unattended: what is different, and why

| topic                 | AO                                                                                                     | Gas Town                                                                                                            | orch                                                                                                                      | why                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| What keeps running    | a daemon owned by the desktop app                                                                      | a daemon plus supervising agents that watch the workers and each other                                              | nothing: `orch start` is a foreground command and everything ends with it                                                 | One person's machine. A process the user started and can see cannot leave an agent working unnoticed                                 |
| How much at once      | many sessions; no overall limit found                                                                  | many workers; an optional scheduler caps them                                                                       | one ticket at a time                                                                                                      | Serial work means no merge queue, few conflicts, and one verification run at a time on a single machine                              |
| How a session starts  | an interactive terminal session, about fifty agent CLIs, `--permission-mode auto` unless set otherwise | an interactive tmux session, `--dangerously-skip-permissions` by default, the confirmation dialogs answered for it  | a headless `claude -p` child, `--permission-mode auto` with a short allow-list, never a bypass; Claude Code only          | Nobody is there to answer a prompt, so the session gets exactly what the factory needs and no more                                   |
| What decides a step   | an orchestrating agent, from its prompt                                                                | agents, from written procedures ("agent decides, Go transports")                                                    | `orch factory next` returns the step; transitions and gates are TypeScript                                                | A stage counts only when its artifact and evidence were validated by code, not when an agent reports it                              |
| Talking to a session  | CI failures, review comments, and conflicts are typed into the owning session                          | mail, and nudges typed into the session                                                                             | never; a session reads notices on its next `orch factory next`                                                            | Typing into a session is not something `orch` can do reliably, and a job must not depend on a message arriving                       |
| A failing check       | sent to the worker again for every new failure, without a limit                                        | the merging agent decides whether the branch caused it                                                              | one bounded re-run, then a recorded rework through build and review, limited by `maxCiRepairs`                            | A repair is new code and is reviewed; a budget turns an endless loop into a ticket that waits for a person                           |
| A quiet session       | left alone; an agent or a person interrupts or kills it                                                | flagged after 30 minutes without an update; dead workers are restarted; a stale supervisor is nudged, then replaced | left alone; only the process ending ends the wait, and two exits without progress stop the ticket                         | Silence is not evidence of failure: a builder or a test run can be quiet for a long time                                             |
| After a crash         | live sessions are adopted; dead ones stay stopped until a person resumes the same conversation         | a dead worker is restarted in its worktree and continues from its assigned work                                     | `orch resume` re-reads the ticket's jobs and starts a new session on the same job; refused while the old one may be alive | State is in the job row and its artifacts, not in a conversation, so any session can continue and only the stage in flight is redone |
| Stopping              | interrupt or kill one session                                                                          | stop everything, shut down with a grace period, or freeze every session in place                                    | `orch stop next` finishes the ticket in flight; `orch stop` ends the session and keeps the job                            | The useful stop for a queue is "after this one"; neither cancels work                                                                |
| Where a person stands | notified: needs input, ready to merge                                                                  | opt-in review and per-item flags                                                                                    | a `needs-human` stage that the job cannot leave by itself, and that stops the queue                                       | A decision that needs a person is a state the workflow enforces, not a notification that can be missed                               |

### The short version

AO is a desktop product for supervising many agent sessions at once: it watches GitHub, feeds
failures and review comments back into each session, and leaves the merge to a person. Gas Town is
a town of long-lived agents that assign, supervise, and merge each other's work, with a daemon to
keep them alive and deterministic commands at a few critical points. `orch` is neither: it is one
strict pipeline per ticket, where code decides every step and holds every gate, agents only do the
work inside a stage, and the merge is a checked operation rather than a judgement.

That buys evidence and predictability and gives up breadth. If you want many agents working at
once, agents other than Claude Code, a live view of every session, or review comments fed back to
the agent automatically, AO does that and `orch` does not. If you want a self-running system that
restarts and nudges its own agents and merges locally without a pull request, Gas Town does that
and `orch` does not.

## What is not built

Nothing picks a ticket and starts a job in the background: there is no scheduler and no merge
queue. Each step above is one command that someone, or a skill, runs, or that `orch start` runs
in the foreground for as long as that command is running
([workflow.md](workflow.md#factory-controller)). Nothing runs on the
merged result either: "verified" means GitHub merged the commit that passed its checks.
