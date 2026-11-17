---
name: factory
description: Run the AI software factory on the current repository. Use for "/factory <request>" to start a job that specifies, implements, reviews, approves, and opens a draft PR for a feature or fix; "/factory <job-id>" or "/factory resume <job-id>" to continue a job from saved state; "/factory status <job-id>" to report. Coordinates subagents through the `orch` CLI; never edits workflow state directly.
argument-hint: '<request> | <job-id> | status <job-id> | resume <job-id> | dispatch <targets> | cancel <job-id>'
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
- `orch` refuses incomplete or stale work. When a command exits non-zero, read its message and fix
  the cause (redo the stage if evidence went stale); never work around it.
- Subagents work only inside the job worktree, never the user's checkout. Give every subagent the
  absolute worktree path and artifact directory in its prompt; they do not inherit this context.
  Compare `plan.checkoutDirty` across `next` calls: a file that appeared in the user's checkout was
  written by the wrong process. Report it; never clean it up yourself.
- Automated validation is `orch verify <id> --token <t>`, nothing else; agents cite its run id and
  reviewers read its logs. A run can outlast the Bash tool's time limit; Claude Code then keeps it
  running in the background. Wait for that invocation's completion notice and read its result.
  Never start a second `orch verify` for the job while one is running, and never treat an
  unfinished one as a pass: only a finished run with status `passed` (`orch verify show <id>`)
  counts.
- `plan.verification.configured === false` (no policy on the base branch): do not invent checks or
  skip the gate. Ask the builder to propose a `factory.json` in the worktree (never run it), then
  escalate with reason "verification policy needs human acceptance"; resume after the human accepts
  it on the dashboard (or commits one with `orch init`). `plan.verification.policy.authorization ===
'required'` (the worktree changed the policy) also needs that human acceptance.
- Put every path in `plan.sensitive.needsReview` into the reviewer prompts.
- Escalate rather than approve around a blocking finding.
- Never run `git push --force`, `gh pr merge`, `gh pr ready`, or `gh run rerun`; never push outside
  `orch gh push`; never delete branches or worktrees. `orch gh ci` requests the one bounded re-run
  and marks a passing PR ready; humans merge.

## 0. Preflight

```sh
orch doctor
```

`orch` must be on PATH (the user ran `npm link` in the orchestrator repo) and Git must be OK.
`gh` is needed only for the final stage. If `orch` is missing, stop and say how to install it.

Pick a session name once and reuse it for the whole job: `claude-<YYYYMMDD-HHMM>-<4 hex>`.

## 1. Parse the argument

| Argument                        | Action                                                                   |
| ------------------------------- | ------------------------------------------------------------------------ |
| `status <job-id>`               | `orch factory status <id> --json`; summarize; stop.                      |
| `resume <job-id>` or `<job-id>` | `orch factory resume <id> --session <s> --json`; go to step 3            |
| `cancel <job-id>`               | `orch factory cancel <id> --reason "<why>" --session <s> --json`; report |
| `dispatch <targets>`            | step 2b: one job per target, each in its own session                     |
| anything else (a request)       | step 2                                                                   |

Job ids look like `job-1a2b3c4d`.

## 2. Start a job (from the invoking repository)

The target repository is the one this session runs in. Confirm with `git rev-parse --show-toplevel`;
if the session is not inside a Git repository, stop and ask the user to open one.

```sh
orch factory start --title "<concise title>" --description "<the user's request, verbatim>" \
  --session <s> --json
```

A job needs its request: `--description` is required unless `--issue <#N|url>` is given, and a
missing or blank description is refused (exit 2, nothing created). Use `--issue` when the request
names an issue (the title is fetched when `--title` is omitted, the description, the issue's URL
and body, when `--description` is omitted); `--base <branch>` if the target branch is not the
current one. The output contains `token` (keep it; it is the only credential for this job),
`job.worktreePath`, `job.branch`, and `plan`. Tell the user the job id, worktree, and branch in one line, then continue.

## 2b. Dispatch jobs to other repositories, or several at once

A request such as "start a job for issue 123 in repository B, one for #45 in repository C, and one
for this repository" is a dispatch: this session prepares each job and launches an independent
session per job, then returns to its own work. It never runs the children's stages itself, and it
does not wait for them.

For each target, in order, continuing with the next target when one fails:

1. Resolve the repository path (a path the user gave, or `git rev-parse --show-toplevel` for "this
   repository") and prepare the job:

   ```sh
   orch factory dispatch --repo <path> --issue <#N|url> [--title <t>] [--description <d>] [--base <b>] --session <s> --json
   ```

   Without an issue, pass `--title <t> --description "<the request for that target, verbatim>"`
   instead of `--issue`; a dispatch with neither a description nor an issue is refused.

   `dispatch` only creates the job. If it is refused, report that target's message and move on. A
   repeat for the same repository and issue returns the existing job (`duplicate: true`). A
   dispatch with `--description` but no `--issue` has no such key: before retrying one, find the
   job it created in `orch factory list --repo <path>` and launch that.

2. Launch the session from the result's `launch` block. In VS Code's Agents window this harness has
   the `create_session` tool: call it with `relationship: "independent"`,
   `workspace: launch.workspace`, `worktree: true`, `title: launch.title`, `prompt: launch.prompt`.
   The child's `/factory <id>` adopts the worktree VS Code created (step 3). Record the link the
   tool returned:

   ```sh
   orch job session attach <id> --provider vscode-agents --ref <agent-host-session://... link> --session <s>
   ```

   No token: the job is unowned until the child claims it, so run this attach immediately after
   `create_session`; once the child has claimed the job (often within a minute) the token-less
   attach is refused with exit 4, which is harmless because the child records its own session
   (step 3). Without the tool, give the user `launch.fallback` verbatim and say that the session
   was not started by you.

3. Report one line per target: job id, repository, session link or fallback command, and the
   refusal reason for targets that failed.

Afterwards, `orch factory list --json` shows every job and the resume command for jobs no live
session holds. A child that stopped is resumed from any session with `/factory <id>`; when it has
clearly died (step 3), the relaunch prompt tells the new session to resume with `--force` and
states the evidence.

## 3. The loop

Repeat until `plan.step` is `done`, `needs-human`, or `cancelled`:

```sh
orch factory next <job-id> --json
```

Read `plan.reason`, then act on `plan.step`:

- `resume`: `orch factory resume <id> --session <s> --json`. Every claim or resume issues a new
  token; use the new `token` from now on. The unforced resume is the default. Add `--force` only
  when the user explicitly said to take over a live session, or when the owning session has
  clearly died and you saw the evidence: its process, background task, or `create_session` child
  exited; its run was stopped or killed; or its log shows the API or network was lost (for example
  `ENOTFOUND`). Guessing is not evidence, and a quiet session or a slow response is not either. If
  the owner might still be alive, do not force: report the holder and lease expiry (the exit-4
  message or `plan.owner`), then wait for the lease to lapse or stop with the resume command.
- A session dispatched into a linked worktree (`git rev-parse --git-common-dir` is not
  `<toplevel>/.git`) resumes a job with no worktree yet (`job.worktreePath` is null) with
  `--adopt <toplevel>`. A worktree the job already has is never replaced.
- After `start` or `resume` succeeds, record this session when the harness can name it: in VS
  Code's Agents window call `get_current_session` and run `orch job session attach <id>
--provider vscode-agents --ref <openLink> --cwd <toplevel> --token <t>`. Navigation metadata only;
  ownership stays the lease.
- `create-worktree`: run the listed command, then `next` again.
- `needs-human`: release the job (`orch job release <id> --token <t>`), report
  `plan.blockedReason`, the job id, and the exact resume command; stop.
- `done`: run `orch gh pr status <id> --json`; report the PR URL and the CI state `orch` recorded
  for the delivered head; stop.
- `cancelled`: report it; stop.
- `run-stage`: run `plan.commands` in order. Where the list names an agent step (between `start`
  and `artifact add`), launch the agents in `plan.agents` as described below, then verify their
  artifact exists before registering it. Substitute `<token>`, `<pass|changes>`, and `<one line>`
  from the agents' results.

Failures:

- `orch verify` exits 1 on a failed required check: send the builder the failing check's log path
  once; if it fails again, `fail` the stage and escalate.
- An artifact is refused as malformed: send the same agent one correction message naming the
  missing section or marker. If it fails again, run
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

plus the stage-specific inputs listed in [reference.md](reference.md). Wait for every agent to
finish before registering anything.

### Spec stage

The plan walks the spec stage one step at a time: write `spec.md`, challenge it, revise once,
challenge again, then `complete` or `escalate`. Run `orch factory next` after each registration.
Launch `factory-spec-challenger` as its own fresh subagent, never the spec writer's session or
yourself, and give it the request, not your summary of the spec. `orch` refuses to leave `spec`
without a `VERDICT: PASS` bound to the registered `spec.md`.

### Review rounds

Follow `plan.commands`; the coordinator adds:

- Record every reviewer as pending first
  (`orch job review record <id> --reviewer <name> --token <t>`) and capture
  `plan.worktree.fingerprint`. When `plan.ui` is true and the project has Playwright or a
  screenshot script, run it once in the worktree and save output under
  `<artifactDir>/round-N/evidence/` so all reviewers share one evidence set.
- Launch all reviewers concurrently (one message, several Agent calls) when the harness allows it;
  otherwise sequentially. Every round runs every reviewer in `plan.agents`.
- If `orch factory check-readonly` exits 1, the round failed: `orch job transition <id> fail`.
- Record each verdict from the reviewer's `VERDICT:` line.
- Write `round-N/consolidated.md` (template in reference.md): deduplicate actionable findings
  across reviewers, drop anything out of scope for the spec, and count `BLOCKING: <n>` honestly;
  `n > 0` sends the job back to build even when every verdict is PASS. Register it with
  `orch job artifact add <id> round-N/consolidated.md --token <t>`. The next builder gets this file
  and must address every blocking finding without expanding scope.

### Approval and delivery

If `decision.md` says `ESCALATE`, run `escalate` with its reason. If `APPROVE`, follow the `pr`
stage commands. After `orch worktree integrate`, run `orch factory next` again because HEAD
changed. A conflicting merge sends the job back to `build`: never resolve conflicts or merge by
hand, and never `--force` anything; on resume, `orch worktree integrate` reconstructs an
interrupted attempt.

### CI reconciliation (the `ci` stage)

`orch gh ci <id> --token <t>` reads GitHub's checks for the PR head and acts; read its `action`:

- `wait`: sleep exactly `waitSeconds` (`sleep <n>`) in a Bash call of its own, then run
  `orch factory next` and the command again in the next call. Never chain the wait and the `orch`
  commands in one script, so that a session killed while waiting leaves no scheduled write behind.
  When `plan.ci.release` is true, the plan's only command is `orch job release <id> --token <t>`:
  run it, tell the user CI is still running, give the resume command, and stop.
- `complete`: the job is `completed`; `orch factory next` confirms `done`.
- `rework`: the job is back in `build`. Give the builder the saved log paths and failing check
  names, and require a real fix, never weakening tests, checks, `factory.json`, or CI workflows.
- `exhausted` or `escalate`: the job is in `needs-human`; handle it as above.

If `orch gh ci` exits 1 because GitHub or the network failed, nothing was recorded: retry once
after a minute, then release the job and report.

## 4. Report

End with: job id, stage reached, worktree and branch, review rounds and verdicts, blocking
findings left (should be none unless escalated), CI repair cycles used, PR URL and CI status
(`pending`/`passing`/`failing`/`none` as `orch` recorded it for the PR head, never "green" unless
`orch gh ci` said `passing` for the current head; report its `ready` field), and the resume
command. If you used `--force`, name the evidence that the previous session had died. Say "delivered" only when the job is `completed`; a draft PR is not passing CI and a
mocked check is not a real one. Distinguish what was verified by commands from what an agent
reported.

## Limits

This skill cannot restart a Claude session that stopped; it only resumes from state. Dispatch
starts sessions only through the host's documented `create_session` tool; `orch` never starts a
Claude process, and a printed fallback command is not a started session. Ownership is a
database lease: it stops two sessions from both recording changes to one job, but any process can
still write into a worktree directory it is pointed at, which is why prompts always carry the
worktree path, evidence is accepted only from a clean worktree at a recorded commit, and reviews
are fingerprint-checked. There is no daemon; nothing happens between your commands. Never archive
or delete a dispatched child's VS Code session while its job is live: VS Code removes that
session's worktree, which is the job's worktree. Stop a child with a message, or let its lease
lapse.
