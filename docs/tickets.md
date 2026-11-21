# Tickets

`orch` keeps one private ticket queue for every repository on the machine, in the same SQLite
database as jobs. A ticket is the unit of "something to do": a bug, a feature, a chore, or a
question to decide. Jobs are attempts to do one. There is no server, no synchronisation, and no
file in any repository; `orch ticket` works with nothing else running.

What is not built: `orch start`, `orch do <id>`, `orch stop next`, any scheduler or loop that picks
tickets and runs them, merging by the factory, and a ticket page in the dashboard. The model below
is what those would be built on.

## Identity

Every ticket has one number from a single global sequence (`0085` when printed; `85`, `0085`, and
`#85` are all accepted). The column is SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`: allocation is
atomic across concurrent CLI processes, a number is never reused, and nothing renumbers. A ticket
is never deleted; a mistake is dropped or marked a duplicate.

## Repository

A ticket belongs to a repository and records it the way a job does: `repo`, the remote identity
(normalized `origin`, else the directory name), and `repoPath`, the primary checkout. Filing from a
linked worktree records the primary checkout. `orch ticket add` uses the repository containing the
cwd, or `--repo <path>`; outside a repository it refuses rather than guess.

Lists are global. `--repo` narrows them:

- a path (absolute, or containing a separator or a leading dot, such as `.`) selects the tickets
  of that local repository, matched by Git common directory, plus tickets of other clones of its
  remote. This is the rule jobs use (`inRepositoryAt` in `src/ops/repo.ts`), so a remote that was
  added or changed after a ticket was filed does not hide it, and two unrelated repositories with
  the same directory name stay apart;
- anything else is an identity (`github.com/acme/web`) or its last segment (`web`). A short name
  that fits two repositories is refused.

`orch ticket edit <id> --repo <path>` re-associates a ticket (a moved checkout). Creating a job for
a ticket refreshes a stale identity. When the recorded checkout is missing, the ticket is kept
unchanged and reported as blocked by its repository.

## Fields

| field         | values                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| `status`      | `open`, `in-progress`, `done`, `dropped`, `duplicate`. Blocked is derived, not stored.    |
| `type`        | `bug`, `feature`, `chore`, `question` (a decision to make, never executable)              |
| `area`        | one of the thirteen built-in areas (`orch ticket area list`) or one added with `area add` |
| `priority`    | `P1` fix now, `P2` next, `P3` someday, `P4` parked                                        |
| `effort`      | days: `0.25, 0.5, 1, 2, 3, 5`                                                             |
| `classified`  | `auto` or `user`: whether a person gave the area, priority, or effort                     |
| `body`        | the whole Markdown description, stored as text: What, Why, checklists, Screenshot         |
| `duplicateOf` | set exactly while `status` is `duplicate`                                                 |
| `revision`    | incremented by every change; pass `--revision <n>` to refuse a concurrent one (exit 4)    |

Defaults for `add`: `feature`, `other`, `P3`, `1`, `auto`. Areas are one shared list, not per
repository.

Status changes: `start` (open to in-progress), `done`, `drop`, `duplicate --of <id>` (from open or
in-progress), `reopen` (from anything but open; clears `duplicateOf`). `done`, `drop`, and
`duplicate` are refused while an unfinished job is working on the ticket.

## Dependencies and related tickets

Three separate things:

- `orch ticket dep add <id> <other>`: `<id>` **depends on** `<other>` and cannot be ready until
  `<other>` is `done`. Repositories do not matter. A dependency on itself, on a missing ticket, or
  one that would close a cycle is refused with the cycle spelled out.
- `orch ticket related add <id> <other>`: informational, directed as stated, never affects
  readiness.
- `orch ticket duplicate <id> --of <other>`: `<id>` is closed as a duplicate.

Only `done` satisfies a dependency. A dropped or duplicate dependency keeps blocking, and the
reason says what to do (remove the dependency, or depend on the original).

## Order and readiness

`orch ticket order` is the proposed order of the open tickets: dependencies before dependents, then
priority, effort (smallest first), area, id. It is deterministic. An in-progress dependency no
longer holds its dependents back in this order.

`orch ticket ready` is that order filtered to tickets that can be executed now. A ticket is ready
when it is `open`, is not a `question`, every dependency is `done`, no unfinished job is linked to
it, and its repository checkout exists. `orch ticket blocked` is the rest of the open tickets, each
with `blockedBy`: a list of `{kind, detail}` where `kind` is `dependency`, `question`, `active-job`,
or `repository`. `orch ticket next` is the first ready ticket. Reading never claims anything.

## History

`ticket_events` is an append-only log per ticket, separate from job events:
`ticket.created`, `.edited` (title, body, repository), `.reclassified` (type, area, effort,
classified), `.priority-changed`, `.dependency-added` / `-removed`, `.related-added` / `-removed`,
`.started`, `.completed`, `.dropped`, `.reopened`, `.duplicate-marked`, `.job-linked`, `.note`,
`.asset-added`, `.imported`. Field changes carry `from` and `to`; a body change records only its
size. `orch ticket note <id> <text>` adds a dated note; lifecycle commands take `--note`.

## Tickets and jobs

`jobs.ticketId` is a nullable foreign key: a job works on at most one ticket, a ticket has any
number of jobs over time (a cancelled attempt, a re-land), and jobs without a ticket are unchanged.
`issueRef` still means a GitHub issue and nothing else.

- `orch factory start --ticket <id>` and `orch factory dispatch --ticket <id>` create the job for
  a ticket. In the one transaction that inserts the job, the ticket is checked (open or
  in-progress, not a question, dependencies done, no unfinished job), marked `in-progress`, and
  linked. If anything fails, neither the job nor the claim exists. The ticket's title and body are
  the default title and description. `start` must run inside the ticket's repository (from another repository, or outside any, it is
  refused with the ticket's repository and path); `dispatch`
  defaults to it.
- A partial unique index (`jobs_active_ticket_idx`, on `ticketId` where the job is not completed or
  cancelled) makes a second unfinished job for a ticket impossible, whatever races.
- A re-land created by the dashboard's Fix merge conflicts keeps the ticket of the job it replaces.
- A job finishing never closes its ticket. The factory completes before the PR is merged, so
  closing is the explicit `orch ticket done`, which the `dotodo` skill runs after GitHub reports
  the merge.
- `orch ticket start <id>` only marks a ticket in progress (work done by hand); it creates no job.

`orch ticket jobs <id>` lists a ticket's jobs; `orch job show <job>` includes `job.ticketId`.

## CLI

`orch ticket --help` is the reference. All commands take `--json`; lists print
`{ "total": n, "tickets": [...] }` (rows without the body), `show` prints
`{ ticket, dependents, jobs, assets, assetDir, here }` (`here`: the cwd is inside the ticket's
repository), and a mutation prints the ticket. Exit codes are
the usual ones: 1 validation or a refused status change, 2 usage, 3 no such ticket, 4 stale
revision.

```sh
orch ticket add "Fix verification race" --priority P1 --area core --body-file ticket.md
orch ticket list --repo . --status open        # also: order, ready, blocked, next
orch ticket show 85 --json
orch ticket edit 85 --effort 2 --body-file -    # Markdown body from stdin
orch ticket dep add 85 62
orch ticket done 85 --note "merged https://github.com/o/r/pull/7"
```

## HTTP API

`orch ui` serves the same operations (the handlers call the functions the CLI calls, in
`src/ops/tickets.ts`) under the dashboard's guards: loopback only, Host check, and for writes a
same-origin `Origin`, `Content-Type: application/json`, and the CSRF token from `/api/session`.

| request                          | does                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/tickets`               | list; query `view=all\|order\|ready\|blocked`, `repo`, `status`, `priority`, `area`, `type`, `limit`, `offset`                                                                                     |
| `POST /api/tickets`              | create: `{title, repo, type?, area?, priority?, effort?, classified?, body?, dependsOn?, related?}`; `repo` is a path inside the repository                                                        |
| `GET /api/tickets/<id>`          | the ticket, dependents, jobs, asset names                                                                                                                                                          |
| `GET /api/tickets/<id>/history`  | its history                                                                                                                                                                                        |
| `GET /api/tickets/<id>/jobs`     | its jobs                                                                                                                                                                                           |
| `POST /api/tickets/<id>/actions` | `{action, revision?, ...}`: `edit` (fields), `note` (`text`), `start`, `done`, `drop`, `reopen` (`note?`), `duplicate` (`of`), `dep-add`, `dep-remove`, `related-add`, `related-remove` (`target`) |
| `GET`, `POST /api/tickets/areas` | list areas; add `{name, description}`                                                                                                                                                              |

Errors use the dashboard's mapping: 404 no such ticket, 422 invalid input, 409 a refused status
change or a stale `revision`. Creating a job for a ticket and attaching assets are CLI only.

## Assets and privacy

Tickets, their history, and their assets live in the per-user data directory (`ORCH_HOME`, else
the platform default): the database, and `tickets/<NNNN>/assets/` for files.
`orch ticket asset add <id> <file>` copies a file there. Nothing is written into a repository, and
the HTTP API serves asset names only, never file contents or arbitrary paths. Global queries are
intentional: this is one person's machine.

## Importing the Markdown register

Before tickets, this repository kept a private, gitignored `todo/` directory: one
`NNNN-slug.md` per todo with thirteen frontmatter keys in a fixed order (`id, title, status, type,
area, priority, effort, depends_on, related, duplicate_of, classified, created, updated`), a
Markdown body with a dated `## Notes` list, an `areas.md`, and optional `assets/`.
`orch ticket import` reads that format (`src/core/todo-register.ts`).

```sh
orch ticket import --dry-run --json    # from the primary checkout: the plan, nothing written
orch ticket import --json              # the import, in one transaction
```

- Everything is parsed and cross-checked first (fields, references, cycles). Any problem stops the
  import with the file and line; nothing is written and no number is consumed.
- Ids: when none of the register's ids is taken, every todo keeps its id. Otherwise the whole
  register gets new consecutive ids after the highest ticket, and `depends_on`, `related`, and
  `duplicate_of` are rewritten through the map. The original id is kept as `importId`, and the
  report's `idMap` lists old to new. Text inside bodies is not rewritten.
- Bodies are stored whole, Notes included, so nothing a person wrote is lost. Created and updated
  dates are kept as written. Each ticket gets one `ticket.imported` history row.
- Jobs: a job of the same repository whose title names exactly one todo (`Todo 0074: ...`,
  `0044 ...`, `... (todo 8)`, `... (0052)`) is linked to that ticket. A title naming several, a
  second unfinished job for one ticket, and job ids merely mentioned in a body are reported under
  `jobs.ambiguous` or `jobs.unresolved` and not linked.
- Assets named `NNNN-*` are copied to the ticket's asset directory.
- The report lists every todo under `tickets` (register id, ticket id, title, status, priority,
  mapped `dependsOn`, `related`, `duplicateOf`) next to the counts, so a dry run can be reconciled
  against the register before anything is written.
- The register's files are only read. Each ticket's `ticket.imported` row stores a fingerprint of
  its todo (every frontmatter value and the body). Running the import again for a register that is
  exactly as it was imported changes nothing (`alreadyImported: true`); one with a changed, added,
  or removed todo is refused, naming the ids.
  After the import the database is the only source of truth: there is no export and no sync.

Keep the `todo/` directory until the report has been checked; it is the backup.

## Skills

`orch install` links both skills into `~/.claude/skills` next to `factory`, so `/log-todo` and
`/dotodo` work in every repository; in this checkout they are also project skills.

`.claude/skills/log-todo` files and maintains tickets through `orch ticket --json`: it decides the
split, the duplicate check, and the classification; `orch` allocates ids and enforces every rule.
`.claude/skills/dotodo` runs one ticket through the factory with `--ticket <id>`, merges under its
unchanged rules, and closes the ticket after the merge.

## What was taken from Beads

[Beads](https://github.com/steveyegge/beads) (read at commit `7862410`) informed the model; none
of it is a dependency. See `docs/decisions/2026-11-20-global-ticket-queue.md`.
