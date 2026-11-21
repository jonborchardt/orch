---
name: log-todo
description: Use when the user types "/log-todo ..." or asks to log, file, note or jot a bug, todo, idea or gap for later in this repo (not now), to mark a logged todo done or dropped, to reclassify one, to merge duplicates, or to see the todo list or index.
---

# log-todo

Todos are tickets in orch's private, global queue (`orch ticket --help`, `docs/tickets.md`): one
SQLite database for every repository, never a file in a repository. You decide what a ticket says and
how it is classified; `orch` owns ids, storage, validation, links, order and history. Every command
takes `--json`; read that, never the text tables. You never read source code to size an item: the
areas list, the repo's instructions file and the request are enough.

Run `orch ticket` from inside the repository the todo is about (a new ticket belongs to the cwd's
repository; `--repo <path>` names another). Lists are global unless you pass `--repo .`.

## Verbs

The first word is a verb only when it is one of these **and** the rest fits the shape; otherwise the whole text is
logged ("done with the board filter" is a todo, not a close).

| verb | shape | does |
| --- | --- | --- |
| `log` (default) | any text, pasted images, paths | files one or more tickets (below) |
| `done <id>`, `drop <id>` | an id | `orch ticket done\|drop <id> --note "<why>"` |
| `start <id> ...` | one or more ids | `orch ticket start <id> --note "<why>"` each: in progress, out of the proposed order |
| `dup <id> <of>` | two ids | append `<id>`'s What to `<of>`'s What as a checklist item (`edit --body-file -`), then `orch ticket duplicate <id> --of <of> --note "<why>"` and `orch ticket note <of> "merged <id>"` |
| `reclassify <id> key=value ...` | area, priority, effort, type, depends_on, related | `orch ticket edit <id> --area/--priority/--effort/--type ... --classified user`; `orch ticket dep add\|remove <id> <other>`; `orch ticket related add\|remove <id> <other>` |
| `show [<id> \| <area>]` | nothing, an id or an area | `orch ticket show <id>`, `orch ticket list --area <a> --repo .`, or with nothing the proposed order: `orch ticket order --repo .` (plus `orch ticket list --status in-progress --repo .`); writes nothing |

`orch` records each change in the ticket's history (old and new values, the date, the note), so there
is no Notes section to maintain and no index to regenerate. Exit 1 names what was refused (an unknown
area, a dependency cycle, a closed ticket); exit 3 is no such id.

## log

1. `orch ticket list --repo . --json` and `orch ticket area list --json`: every ticket of this
   repository (id, title, area, status; no bodies) and the areas. Never fetch every body.
2. Split the text into distinct todos only when it plainly holds more than one. Items that must land together are one
   todo with a checklist in What. **Question 1** (only if the split is ambiguous): "One todo or two: X and Y?"
3. Dedupe against the list. Same subject as an **open** or in-progress ticket: **question 2**, "Merge into NNNN
   (title)?" Yes: `orch ticket show NNNN --json`, append the text to its What as a checklist item, write the body back
   with `orch ticket edit NNNN --body-file -`, add `orch ticket note NNNN "<what was merged>"`, file nothing; its
   classification stays (say so in the reply if the new text argues for a higher priority). Same subject as a done or
   dropped ticket: a new ticket with `--related <that id>`, no question.
4. Classify each todo: `type` (`bug|feature|chore|question`; a question is a decision to make, not code), `area` (an
   existing area whenever one fits; if none does, `orch ticket area add <name> --description "<d>"` first and say so),
   `priority` (P1 fix now, P2 next, P3 someday, P4 parked: only when the user says so), `effort` in days from
   `0.25, 0.5, 1, 2, 3, 5` (an educated guess), `--depends-on` and `--related` by id. Values the text gives (`p1`,
   `area: api`, `2 days`, `depends on 7`, `blocks 9`) are taken as given; "blocks 9" is `orch ticket dep add 9 <new id>`
   after filing. `--classified user` when the text gave any of area, priority or effort, else `auto`. Two items
   combined into one take the higher priority and the summed effort (rounded up to the scale).
5. Screenshots. A pasted image: transcribe it into `## Screenshot` (the page or command, the exact error text, the UI
   state); its pixels cannot be saved. A path: after filing, `orch ticket asset add <id> <path>` (it is copied into
   orch's private data directory, never the repository), name the file in `## Screenshot`, read it once and transcribe
   it too. Text that mentions a screenshot with neither: **question 3**, "Paste the screenshot or give me its path."
6. File it, the body on stdin so nothing needs shell escaping:

   ```sh
   orch ticket add "<title>" --type bug --area web --priority P2 --effort 0.5 \
     --classified auto --depends-on 7 --related 12 --body-file - --json <<'EOF'
   ## What
   ...
   EOF
   ```

   Then `orch ticket note <id> "<which of area, priority, effort were given and which guessed>"`.
   Reply one line per ticket: `NNNN  title  area  P?  effort d` plus the guess you are least sure of.

No other question is ever asked.

## The body

```markdown
## What

The text, lightly tidied, one paragraph; a combined todo has a checklist here, one box per item.

## Why it matters / what it blocks

One or two lines, your reading. Omit the section when it adds nothing.

## Screenshot

Transcription; the asset's file name when a path was given. Omit when there is none.
```

The title is one line. No personal data (names, emails, credentials) in a ticket.

## Common mistakes

- Grepping the code to size an item. Guess from the area and the request.
- Writing a ticket, an index or a table as a file. Only `orch ticket` stores tickets; `todo/` is a
  read-only archive of the register that was imported.
- Picking the id yourself. `orch ticket add` allocates it and prints it.
- Trying to delete a ticket to undo a mistake. Use `drop` or `dup`; ids are forever.
- Guessing P4. Parked is the user's call.
- A new area for every item. Choose an existing one unless nothing fits.
- A fourth question. Guess, mark `auto`, name the shaky guess in the reply.
