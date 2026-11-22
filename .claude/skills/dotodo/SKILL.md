---
name: dotodo
description: Use when the user types "/dotodo <id>" or asks to do, run, ship or finish a logged todo by its id in this repo, end to end (factory job, merge, close the todo).
---

# dotodo

Takes one ticket id from orch's ticket queue (see the `log-todo` skill and `orch ticket --help`),
runs one factory job for it, merges the PR when everything passed, and closes the ticket. One id per
invocation, in this session.

This skill does not merge by itself and holds no merge rules: `orch job merge` does both, and only
where the user opted the repository in (decision 2026-11-20-orch-job-merge). The `factory` skill's
rules stay as written while the job runs (the `factory` session never merges and never resolves a
conflict by hand; `orch job merge` merges afterwards, where the repository is opted in);
`dotodo` acts only after the job is `completed`.

Tickets live in orch's database, not in the repository: read and change them only with
`orch ticket ... --json`, from any checkout or worktree. A job finishing never closes a ticket; a
verified merge does, through `orch job merge`, unless checklist items are still unchecked.

## 1. Check the ticket

`orch ticket show <id> --json`. Stop, changing nothing, and say why when:

- there is no such id (exit 3), or `ticket.status` is not `open` or `in-progress`;
- `here` is `false`: this session is not inside the ticket's repository (another repository, or no
  Git checkout at all). The ticket decides where the work happens, never the current directory:
  tell the user the ticket belongs to `ticket.repo` and to run `/dotodo <id>` from a session opened
  in `ticket.repoPath`. Do not `cd` there, and do not start the job with `--repo`;
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

`orch job show <job> --json`. Go on to step 4 only when `stage` and `status` are `completed`.
Anything else:

| outcome                                                                 | do                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `needs-human`, escalated, CI repairs exhausted, policy needs acceptance | no merge; ticket stays `in-progress`; `orch ticket note <id> "<reason>; resume: <command>"`; report and stop |
| the spec stage finds the work is already on `main`                      | `orch factory cancel` with that reason; `orch ticket done <id> --note "<the commit or PR that fixed it>"`    |
| cancelled for any other reason                                          | ticket stays `in-progress` with an `orch ticket note`; report and stop                                       |

## 4. Check what the PR covered

A merge closes the ticket only when no checklist item in its body is unchecked. The factory's
approve stage already ticked the boxes this PR delivers: the approver's `decision.md` lists every
box under `## Ticket checklist` as `- [x] <item> — <evidence>` or `- [ ] <item> — <reason>`, the
factory session ticks the delivered ones with `orch ticket edit`, and `orch` refuses to complete
approval until every unchecked box is ticked or recorded there (that line is the enforced record;
the `orch ticket note` copy is best effort). So before merging, only check `ticket.body` from
`orch ticket show <id> --json`; never tick a box the PR did not deliver. A box left unticked (a
rerun, a setting on GitHub) keeps the ticket `in-progress` after the merge, which is correct. A job
approved before this rule existed may need its delivered boxes ticked here with
`orch ticket edit <id> --body-file -`.

## 5. Merge

```sh
orch job merge <job> --json
```

That one command checks every merge rule against GitHub's fresh state, merges the CI-verified head
as a merge commit, confirms the result with GitHub, records the merge commit, and closes the ticket
when nothing is left on it. It is safe to run again after any failure. Never run `gh pr merge`,
`gh pr view`, or `orch ticket done` in its place. Act on `outcome`:

| `outcome`        | do                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merged`         | step 6                                                                                                                                                                                                                                         |
| `already_merged` | step 6 (GitHub had merged it; the record is complete now)                                                                                                                                                                                      |
| `waiting`        | GitHub is still computing mergeability: run the command again after a minute, three times at most, then report and stop                                                                                                                        |
| `reland`         | the PR conflicts. orch created `relandJob` on the same ticket and superseded this job: run `/factory <relandJob>` to its end, then repeat steps 3 to 5 for it. Never resolve the conflict by hand. Tell the user the old PR is left open       |
| `blocked`        | no merge. `code: not-authorized`: tell the user merging is not enabled for this repository and that `orch factory config merge enable` turns it on; do not run it yourself. Any other `code`: `orch ticket note <id> "<reason>"`. Report, stop |
| `error`          | a tool or GitHub failure: run the command once more; if it repeats, report `reason` and stop                                                                                                                                                   |

`merged` and `already_merged` are a success only with `verified: true` (exit 0). With
`verified: false` (exit 1) the PR was merged at a head CI did not pass on: report that and stop.

`code: second-conflict` means the re-land conflicted too: no third job. Leave the branch, the
worktree, the primary checkout and `dist/` alone.

## 6. Report

From the merge result: ticket id and final status (`ticket.completed`; when false, `ticket.reason`
and `ticket.remaining` say what is left for the user), job id, PR URL, `mergeCommit`, review rounds,
whether `verified` is true, and any superseded PR the user may want to close.

## Common mistakes

- Merging with `gh`, or closing the ticket with `orch ticket done` after a merge: both are
  `orch job merge`'s job, and it alone knows whether the merge was verified.
- Enabling merge authorization yourself, or working around a `blocked` outcome.
- Ticking a checklist box the PR did not deliver so that the ticket closes.
- Fixing a conflict in the worktree, or pushing to the PR branch, yourself.
- `gh pr ready`, `gh pr close`, `gh run rerun`, `--admin`, force-push, deleting a branch or worktree.
- Starting the factory job without `--ticket <id>`: the job would not be linked, and the ticket
  would not be claimed.
- Writing a file under `todo/`: it is a read-only archive of the imported register.
