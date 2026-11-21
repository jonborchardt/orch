---
name: dotodo
description: Use when the user types "/dotodo <id>" or asks to do, run, ship or finish a logged todo by its id in this repo, end to end (factory job, merge, close the todo).
---

# dotodo

Takes one ticket id from orch's ticket queue (see the `log-todo` skill and `orch ticket --help`),
runs one factory job for it, merges the PR when everything passed, and closes the ticket. One id per
invocation, in this session.

This skill is the only thing here that merges. The `factory` skill's rules stay as written while the
job runs (it never merges, never resolves a conflict by hand); `dotodo` acts only after the job is
`completed` (decision 2026-11-18-dotodo-merges-outside-the-factory).

Tickets live in orch's database, not in the repository: read and change them only with
`orch ticket ... --json`, from any checkout or worktree. A job finishing never closes a ticket; this
skill does, after the merge.

## 1. Check the ticket

`orch ticket show <id> --json`. Stop, changing nothing, and say why when:

- there is no such id (exit 3), or `ticket.status` is not `open` or `in-progress`;
- `ticket.type` is `question` (a decision, not code);
- `ticket.blockedBy` names a dependency that is not `done`, or a repository that is not available;
- `ticket.activeJob` is set: a job is already working on it. Continue that job with `/factory <job>`
  instead of starting another, then go on from step 3.

## 2. Start

1. Invoke the `factory` skill with this request (plain text; the factory start command is run through
   Bash with the description in single quotes, since PowerShell truncates at an embedded `"`; check
   `job.description` in its output before launching any agent), adding `--ticket <id>` to its
   `orch factory start` command:
   - title: `Todo NNNN: <ticket title>`
   - description: `Todo NNNN (<ticket title>). <the What section, checklist included>`, then
     `Out of scope: <each checklist item that is not a change to this repository>` when there are any.

   `--ticket` links the job to the ticket and marks the ticket `in-progress` in the same transaction;
   it is refused, creating nothing, when the ticket is blocked or already has an unfinished job. The
   job appears under `orch ticket jobs <id>` and in the ticket's history, so no note is needed for it.

2. Follow the factory skill to its end.

## 3. Read the outcome

`orch job show <job> --json`. Merge only when all of these hold; they are what the dashboard's own
Merge button requires:

- `stage` and `status` are `completed`, by a CI verdict (`ciHead` is set, not a human acceptance);
- `ciStatus` is `passing`; `prState` is `ready`; `prUrl` is set.

Anything else:

| outcome                                                                 | do                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `needs-human`, escalated, CI repairs exhausted, policy needs acceptance | no merge; ticket stays `in-progress`; `orch ticket note <id> "<reason>; resume: <command>"`; report and stop |
| the spec stage finds the work is already on `main`                      | `orch factory cancel` with that reason; `orch ticket done <id> --note "<the commit or PR that fixed it>"`    |
| cancelled for any other reason                                          | ticket stays `in-progress` with an `orch ticket note`; report and stop                                       |

## 4. Merge

```sh
gh pr view <prUrl> --json state,isDraft,mergeable,headRefOid
```

- `OPEN`, not draft, `headRefOid` equal to the job's `ciHead`, `MERGEABLE`:
  `gh pr merge <prUrl> --merge --match-head-commit <ciHead>`. A merge commit, never squash or rebase,
  never `--admin`, never `--delete-branch`.
- `UNKNOWN`: GitHub is still computing; look again after a minute, three times at most.
- head differs from `ciHead`: commits nobody verified. No merge; `orch ticket note`; report and stop.
- `CONFLICTING`: step 5.

Leave the branch, the worktree, the primary checkout and `dist/` alone.

## 5. A conflict goes back through the factory

Never resolve it by hand: a resolution is new code and gets the same verification and review. Start a
second factory job, again with `--ticket <id>` (the first job is finished, so the ticket is free; same
title with `(re-land)` appended), whose description is the original one plus:
`Re-land the work of <old job> (PR <url>, branch <branch>) on the current main: start from that
branch's changes, resolve the conflicts with main, keep the original scope.` Then:

1. `orch job supersede <old job> --by <new job> --session <s>`.
2. When the new job reaches step 3's merge conditions, merge its PR (step 4), then
   `gh pr close <old prUrl> --comment "Superseded by <new prUrl>."`.
3. A second conflict: no third job. `orch ticket note`; report and stop.

## 6. Close

1. Confirm `gh pr view <prUrl> --json state,mergeCommit` says `MERGED`.
2. Tick every checklist box in What that the PR covered: take `ticket.body` from
   `orch ticket show <id> --json`, change the boxes, and write it back with
   `orch ticket edit <id> --body-file -`. If boxes remain that are not code (a rerun, a setting on
   GitHub), the ticket stays `in-progress` with an `orch ticket note` listing them; otherwise
   `orch ticket done <id> --note "merged <prUrl> (job <job>)"`.
3. Report: ticket id and final status, job id, PR URL, merge commit, review rounds, and anything left
   for the user. The dashboard shows the merge after Refresh PR.

## Common mistakes

- Merging a PR whose job ended any way other than `completed` on a passing CI verdict.
- Marking the ticket done before GitHub says `MERGED`.
- Fixing a conflict in the worktree, or pushing to the PR branch, yourself.
- `gh pr ready`, `gh run rerun`, `--admin`, force-push, deleting a branch or worktree.
- Starting the factory job without `--ticket <id>`: the job would not be linked, and the ticket
  would not be claimed.
- Writing a file under `todo/`: it is a read-only archive of the imported register.
