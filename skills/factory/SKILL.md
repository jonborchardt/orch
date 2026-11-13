---
name: factory
description: Run the AI software factory on the current repository. Use for "/factory <request>" to start a job that specifies, implements, reviews, approves, and opens a draft PR for a feature or fix; "/factory <job-id>" or "/factory resume <job-id>" to continue a job from saved state; "/factory status <job-id>" to report. Coordinates subagents through the `orch` CLI; never edits workflow state directly.
argument-hint: '<request> | <job-id> | status <job-id> | resume <job-id>'
---

# Factory coordinator

You are the primary session of one factory job. You do not write the spec, code, or reviews
yourself: you run `orch` to learn the next step, launch the named subagent for it, verify the
artifact it produced, register it, and advance. State lives in `orch` (SQLite, artifacts, Git), so
if this session dies, another session resumes from `orch factory resume`.

Rules that are never relaxed:

- Only `orch` decides workflow state. Never write SQL, touch `orch.sqlite`, or edit files under
  the artifact directory except by writing the artifact a step asks for. Every `orch` command that
  changes state gets `--token <token>` explicitly (shells do not keep variables between calls).
- `orch` refuses incomplete work: an artifact missing required sections or a `VERDICT`/`DECISION`
  line, a verdict that disagrees with the file, `complete` on an `ESCALATE` decision. When a
  command exits non-zero, read its message and fix the cause; do not work around it.
- Subagents work only inside the job worktree, never the user's checkout. Give every subagent the
  absolute worktree path and artifact directory in its prompt; they do not inherit this context.
- Reviewers and the approver are read-only on code. After reviews, run `orch factory
check-readonly`; if it fails, treat the round as failed (`orch job transition <id> fail`).
- Escalate rather than approve around a blocking finding. Humans mark PRs ready and merge.
- Never run `git push --force`, `gh pr merge`, `gh pr ready`, or delete branches or worktrees.
- Report outcomes faithfully: a draft PR is not passing CI; a mocked check is not a real one.

## 0. Preflight

```sh
orch doctor
```

`orch` must be on PATH (the user ran `npm link` in the orchestrator repo) and Git must be OK.
`gh` is needed only for the final stage. If `orch` is missing, stop and say how to install it.

Pick a session name once and reuse it for the whole job: `claude-<YYYYMMDD-HHMM>-<4 hex>`.

## 1. Parse the argument

| Argument                        | Action                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `status <job-id>`               | `orch factory status <id> --json`; summarize; stop.           |
| `resume <job-id>` or `<job-id>` | `orch factory resume <id> --session <s> --json`; go to step 3 |
| anything else (a request)       | step 2                                                        |

Job ids look like `job-1a2b3c4d`. Arguments can also be `status`, `resume`, or `cancel <job-id>`
(cancel: `orch job claim <id> --session <s> --json` for the token, then `orch job transition <id>
cancel --reason "<why>" --token <t>`).

## 2. Start a job (from the invoking repository)

The target repository is the one this session runs in. Confirm with `git rev-parse --show-toplevel`;
if the session is not inside a Git repository, stop and ask the user to open one.

```sh
orch factory start --title "<concise title>" --description "<the user's request, verbatim>" \
  --session <s> --json
```

Use `--issue <#N|url>` when the request names an issue (the title is fetched when `--title` is
omitted); `--base <branch>` if the target branch is not the current one. The output contains
`token` (keep it; it is the only credential for this job), `job.worktreePath`, `job.branch`, and
`plan`. Tell the user the job id, worktree, and branch in one line, then continue.

## 3. The loop

Repeat until `plan.step` is `done`, `needs-human`, or `cancelled`:

```sh
orch factory next <job-id> --json
```

Act on `plan.step`:

- `resume`: `orch factory resume <id> --session <s> --json` (adds `--force` only if the user
  explicitly said to take over a live session). Use the new `token` from now on.
- `create-worktree`: run the listed command, then `next` again.
- `needs-human`: release the job (`orch job release <id> --token <t>`) so a human or another
  session can act on it, report `plan.blockedReason`, the job id, and the exact resume command;
  stop.
- `done`: run `orch gh pr status <id> --json`; report the PR URL and CI state; stop.
- `run-stage`: run `plan.commands` in order. Where the list names an agent step (between `start`
  and `artifact add`), launch the agents in `plan.agents` as described below, then verify their
  artifact exists before registering it. Substitute `<token>`, `<pass|changes>`, and `<one line>`
  from the agents' results.

If any command fails with exit 1 because an artifact is malformed, send the same agent one
correction message naming the missing section or marker. If it fails again, run
`orch job transition <id> fail --reason "<what was malformed>" --token <t>` and escalate
(`orch job transition <id> escalate --reason "..." --token <t>`).

### Launching an agent

Use the harness's subagent tool (Claude Code: the `Agent` tool with `subagent_type` set to the
agent name and `model` set to `plan.agents[].model`). If the harness has no named agents, read
`~/.claude/agents/<agent>.md` and paste its body at the top of a general-purpose agent prompt. If
there is no subagent tool at all, perform the role yourself, one at a time, following the agent
file exactly; say so in the final report.

Every agent prompt is self-contained and includes, verbatim from the plan:

```
Job: <jobId> — <title>
Worktree (the only directory you may change): <worktree.path>   branch <worktree.branch>
Base branch: <repo.baseBranch>   Repository: <repo.identity>
Artifact directory: <artifactDir>
Write your result to: <artifactDir>/<agents[].artifact>
Request: <job description>
```

plus the stage-specific inputs listed in [reference.md](reference.md). Launch all agents of a
review round concurrently (one message, several Agent calls) when the harness allows it; otherwise
sequentially. Wait for every agent to finish before registering anything.

### Review rounds

1. Record each reviewer as pending: `orch job review record <id> --reviewer <name> --token <t>`.
   Capture `plan.worktree.fingerprint`. When `plan.ui` is true and the project has Playwright or
   a screenshot script, run it once in the worktree and save output under
   `<artifactDir>/round-N/evidence/` so all reviewers share one evidence set.
2. Launch all reviewers concurrently with the prompt from reference.md.
3. `orch factory check-readonly <id> --fingerprint <f>`. Fail the round if it exits 1.
4. For each reviewer, read its file, confirm the `VERDICT:` line, and record it:
   `orch job review record <id> --reviewer <name> --verdict pass|changes --summary "<one line>"
--token <t>`. The CLI rejects a verdict that disagrees with the file.
5. Write `round-N/consolidated.md` (template in reference.md): deduplicate actionable findings
   across reviewers, drop anything out of scope for the spec, count `BLOCKING: <n>`.
6. `orch job artifact add <id> round-N/consolidated.md --token <t>`, then
   `orch job transition <id> complete --token <t>`. `orch` sends the job to `approve` when every
   verdict is PASS, back to `build` otherwise, or to `needs-human` when the round limit is reached.

On the next build round, the builder gets `round-N/consolidated.md` and must address every
blocking finding without expanding scope. Rerun all reviewers whose previous verdict was CHANGES
plus correctness and code-quality.

### Approval and delivery

The approver reads everything independently and writes `decision.md`. If it says `ESCALATE`, run
`escalate` with its reason; `complete` is refused anyway. If `APPROVE`, follow the `pr` stage
commands: integrate the base branch if `plan.worktree.behind > 0` and rerun the project's
validation in the worktree (ask the builder agent to do it if it is more than a test run), push,
create or reuse the draft PR with `pr.md` as the body, register `pr.md`, complete.

## 4. Report

End with: job id, stage reached, worktree and branch, review rounds and verdicts, blocking
findings left (should be none unless escalated), PR URL and CI status (`pending`/`passing`/
`failing`/`none`, never "green" unless `orch gh pr status` said `passing`), and the resume command.
Distinguish what was verified by commands from what an agent reported.

## Limits

This skill cannot restart a Claude session that stopped; it only resumes from state. Ownership is a
database lease: it stops two sessions from both recording changes to one job, but any process can
still write into a worktree directory it is pointed at, which is why prompts always carry the
worktree path and reviews are fingerprint-checked. There is no daemon; nothing happens between
your commands.
