---
name: dotodo
description: Use when the user types "/dotodo <id>" or asks to do, run, ship or finish a logged todo by its id in this repo, end to end (factory job, merge, close the todo).
---

# dotodo

Takes one todo id from the `todo/` register (see the `log-todo` skill), runs one factory job for it,
merges the PR when everything passed, and closes the todo. One id per invocation, in this session.

This skill is the only thing here that merges. The `factory` skill's rules stay as written while the
job runs (it never merges, never resolves a conflict by hand); `dotodo` acts only after the job is
`completed` (decision 2026-11-18-dotodo-merges-outside-the-factory).

`todo/` is gitignored and exists only in the primary checkout (the directory that holds `.git`, from
`git rev-parse --path-format=absolute --git-common-dir`). Read and write it there, whatever the cwd.
Status changes are `log-todo`'s `start` and `done` verbs: follow that skill for the edit, the dated
Note and the index script.

## 1. Check the todo

Read `todo/NNNN-*.md`. Stop, changing nothing, and say why when:

- there is no such id, or its status is not `open` or `in-progress`;
- `type: question` (a decision, not code);
- an id in `depends_on` is not `done`.

## 2. Start

1. `log-todo start <id>`; the Note says "started; dotodo".
2. Invoke the `factory` skill with this request (plain text; the factory start command is run through
   Bash with the description in single quotes, since PowerShell truncates at an embedded `"`; check
   `job.description` in its output before launching any agent):
   - title: `Todo NNNN: <todo title>`
   - description: `Todo NNNN (<todo title>). <the What section, checklist included>`, then
     `Out of scope: <each checklist item that is not a change to this repository>` when there are any.
3. Add a Note with the job id. Follow the factory skill to its end.

## 3. Read the outcome

`orch job show <job> --json`. Merge only when all of these hold; they are what the dashboard's own
Merge button requires:

- `stage` and `status` are `completed`, by a CI verdict (`ciHead` is set, not a human acceptance);
- `ciStatus` is `passing`; `prState` is `ready`; `prUrl` is set.

Anything else:

| outcome                                                                 | do                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `needs-human`, escalated, CI repairs exhausted, policy needs acceptance | no merge; todo stays `in-progress` with a Note giving the reason and the resume command; report and stop     |
| the spec stage finds the work is already on `main`                      | `orch factory cancel` with that reason; `log-todo done <id>`, the Note naming the commit or PR that fixed it |
| cancelled for any other reason                                          | todo stays `in-progress` with a Note; report and stop                                                        |

## 4. Merge

```sh
gh pr view <prUrl> --json state,isDraft,mergeable,headRefOid
```

- `OPEN`, not draft, `headRefOid` equal to the job's `ciHead`, `MERGEABLE`:
  `gh pr merge <prUrl> --merge --match-head-commit <ciHead>`. A merge commit, never squash or rebase,
  never `--admin`, never `--delete-branch`.
- `UNKNOWN`: GitHub is still computing; look again after a minute, three times at most.
- head differs from `ciHead`: commits nobody verified. No merge; Note; report and stop.
- `CONFLICTING`: step 5.

Leave the branch, the worktree, the primary checkout and `dist/` alone.

## 5. A conflict goes back through the factory

Never resolve it by hand: a resolution is new code and gets the same verification and review. Start a
second factory job (same title with `(re-land)` appended) whose description is the original one plus:
`Re-land the work of <old job> (PR <url>, branch <branch>) on the current main: start from that
branch's changes, resolve the conflicts with main, keep the original scope.` Then:

1. `orch job supersede <old job> --by <new job> --session <s>`.
2. When the new job reaches step 3's merge conditions, merge its PR (step 4), then
   `gh pr close <old prUrl> --comment "Superseded by <new prUrl>."`.
3. A second conflict: no third job. Note; report and stop.

## 6. Close

1. Confirm `gh pr view <prUrl> --json state,mergeCommit` says `MERGED`.
2. Tick every checklist box in What that the PR covered. If boxes remain that are not code (a rerun,
   a setting on GitHub), the todo stays `in-progress` with a Note listing them; otherwise
   `log-todo done <id>` with the Note `merged <prUrl> (job <job>)`.
3. Report: todo id and final status, job id, PR URL, merge commit, review rounds, and anything left
   for the user. The dashboard shows the merge after Refresh PR.

## Common mistakes

- Merging a PR whose job ended any way other than `completed` on a passing CI verdict.
- Marking the todo done before GitHub says `MERGED`.
- Fixing a conflict in the worktree, or pushing to the PR branch, yourself.
- `gh pr ready`, `gh run rerun`, `--admin`, force-push, deleting a branch or worktree.
- Editing `todo/INDEX.md` by hand; only the `log-todo` script writes it.
