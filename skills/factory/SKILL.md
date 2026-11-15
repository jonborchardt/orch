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
- `orch` refuses incomplete work: an artifact missing required sections or a `VERDICT`/`DECISION`
  line, a verdict that disagrees with the file, `complete` on an `ESCALATE` decision. When a
  command exits non-zero, read its message and fix the cause; do not work around it.
- Subagents work only inside the job worktree, never the user's checkout. Give every subagent the
  absolute worktree path and artifact directory in its prompt; they do not inherit this context.
  Compare `plan.checkoutDirty` across `next` calls: a file that appeared in the user's checkout was
  written by the wrong process. Report it; never clean it up yourself.
- Evidence is pinned to commits. `orch` refuses `build.md`, a review verdict, or `decision.md`
  while the worktree has uncommitted changes, and refuses to complete a stage once HEAD moved past
  the commit that evidence describes. When that happens, the stage is redone, not forced.
- Automated validation is `orch verify <id> --token <t>`, nothing else. It runs the repository's
  `factory.json` verification commands in the worktree and records a run id, per-check exit codes,
  and logs under `<artifactDir>/verification/<run>/`. `build`, `approve`, and `pr` cannot complete
  and nothing is pushed without a passing run for the exact HEAD. Agents cannot invent one; a
  `Validation` section in `build.md` cites the run id, and reviewers read the logs, not the prose.
  A verification can outlast the Bash tool's time limit; Claude Code then keeps it running in the
  background. Wait for that invocation's completion notice and read its result. Never start a
  second `orch verify` for the job while one is running, and never treat an unfinished one as a
  pass: only a finished run with status `passed` (`orch verify show <id>`) counts.
- `plan.verification.configured === false` means the base branch has no verification policy. Do
  not invent checks or skip the gate: ask the builder to propose a `factory.json` in the worktree
  (never run it), then escalate with reason "verification policy needs human acceptance". The
  dashboard's **Accept verification policy** records the decision; resume afterwards. (The human
  may instead run `orch init` in the primary checkout, commit and push `factory.json`, and resume.)
- `plan.verification.policy.authorization === 'required'` means the worktree changed the policy.
  The effective policy stays the base branch's until a human accepts the change the same way.
- `plan.sensitive.needsReview` lists test, CI, dependency, or policy files that changed, disabled
  tests, and removed test definitions. Put them in the reviewer prompts; `orch` refuses a
  `consolidated.md` or `pr.md` that lacks a `## Sensitive changes` section naming each path.
- Reviewers and the approver are read-only on code. After reviews, run `orch factory
check-readonly`; if it fails, treat the round as failed (`orch job transition <id> fail`).
- Escalate rather than approve around a blocking finding. `orch gh ci` marks a passing PR ready;
  humans merge.
- Never run `git push --force`, `gh pr merge`, `gh pr ready`, or delete branches or worktrees.
- Report outcomes faithfully: a draft PR is not passing CI; a mocked check is not a real one. The
  job is delivered only when `orch gh ci` has recorded passing required checks for the current PR
  head and `orch` moved it to `completed`.

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
| `dispatch <targets>`            | step 2b: one job per target, each in its own session          |
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

   `dispatch` creates the job and nothing else: no claim, no worktree, no session. It is refused,
   creating nothing, when the repository's `factory.json` is not committed and trusted (the message
   carries `orch init --check`'s verdict) or the base branch does not exist; report that target and
   move on. A repeat for the same repository and issue returns the existing job with
   `duplicate: true`, so retrying after a failed launch never creates a second job. A title-only
   dispatch has no such key: before retrying one, find the job it created in
   `orch factory list --repo <path>` and launch that.

2. Launch the session from the result's `launch` block. In VS Code's Agents window this harness has
   the `create_session` tool: call it with `relationship: "independent"`,
   `workspace: launch.workspace`, `worktree: true`, `title: launch.title`, `prompt: launch.prompt`.
   VS Code creates a worktree of that repository and starts the session in it; the child's
   `/factory <id>` adopts that worktree as the job's (step 3). Record the link the tool returned:

   ```sh
   orch job session attach <id> --provider vscode-agents --ref <agent-host-session://... link> --session <s>
   ```

   No token: the job is unowned until the child claims it, so run this attach immediately after
   `create_session`; once the child has claimed the job (often within a minute) the token-less
   attach is refused with exit 4, which is harmless because the child records its own session
   (step 3). Without the tool, give the user
   `launch.fallback` verbatim (a terminal `claude --worktree ... "/factory <id>"` from the
   repository root, or `code --agents <repo>` to create the session by hand and paste the prompt)
   and say that the session was not started by you.

3. Report one line per target: job id, repository, session link or fallback command, and the
   refusal reason for targets that failed.

Afterwards, `orch factory list --json` shows every job's stage, status, owner, `needsHuman`,
`blockedReason`, `session`, PR, and the resume command for jobs no live session holds;
`orch factory status <id> --json` has the detail. A child that stopped is resumed from any session
with `/factory <id>`.

## 3. The loop

Repeat until `plan.step` is `done`, `needs-human`, or `cancelled`:

```sh
orch factory next <job-id> --json
```

Act on `plan.step`:

- `resume`: `orch factory resume <id> --session <s> --json` (adds `--force` only if the user
  explicitly said to take over a live session). Every claim or resume issues a new token and
  invalidates the old one; use the new `token` from now on.
- A session dispatched into a worktree (its working directory is a linked worktree:
  `git rev-parse --git-common-dir` is not `<toplevel>/.git`) resumes a job that has no worktree yet
  (`job.worktreePath` is null in `orch factory status`) with `--adopt <toplevel>`, so the job's
  worktree is the one this session is isolated in. The result says `adopted` or `kept-existing`; a
  worktree the job already has is never replaced.
- After `start` or `resume` succeeds, record this session on the job when the harness can name it:
  in VS Code's Agents window call `get_current_session` and run `orch job session attach <id>
--provider vscode-agents --ref <openLink> --cwd <toplevel> --token <t>`. Re-attaching the same
  link is a no-op; a different one keeps the earlier ones in the events as history. A session that
  resumes or takes over a job attaches itself too, so `orch factory list` names the session that is
  actually running the job. This is navigation metadata only; ownership stays the lease.
- `create-worktree`: run the listed command, then `next` again.
- `needs-human`: release the job (`orch job release <id> --token <t>`) so a human or another
  session can act on it, report `plan.blockedReason`, the job id, and the exact resume command;
  stop.
- `done`: run `orch gh pr status <id> --json`; report the PR URL and the CI state `orch` recorded
  for the delivered head; stop.
- `run-stage`: run `plan.commands` in order. Where the list names an agent step (between `start`
  and `artifact add`), launch the agents in `plan.agents` as described below, then verify their
  artifact exists before registering it. Substitute `<token>`, `<pass|changes>`, and `<one line>`
  from the agents' results. `orch verify` exits 1 on a failed required check: send the builder the
  failing check's log path once; if it fails again, `fail` the stage and escalate.

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
blocking finding without expanding scope. Every round runs every reviewer in `plan.agents` again;
`orch` refuses to complete a round with a reviewer still pending. `BLOCKING: n` with `n > 0` sends
the job back to build even when every verdict is PASS; count honestly.

### Approval and delivery

The approver reads everything independently and writes `decision.md`. If it says `ESCALATE`, run
`escalate` with its reason; `complete` is refused anyway. If `APPROVE`, follow the `pr` stage
commands: `orch worktree integrate` when `plan.worktree.behind > 0` (it records the inputs and
outcome; run `orch factory next` again afterwards because HEAD changed), `orch verify` on the
resulting commit, push, create or reuse the draft PR with `pr.md` as the body, register `pr.md`,
complete. A conflicting merge, or a merge commit with edits that match neither parent, sends the
job back to `build`: the builder merges the base and resolves, and the result is verified,
reviewed, and approved again before anything is pushed. Never resolve conflicts yourself and never
`--force` anything. On resume, `orch worktree integrate` reconstructs an interrupted attempt from
Git; do not merge by hand.

### CI reconciliation (the `ci` stage)

Completing `pr` is not the end: the job enters `ci`, and the plan's commands are `start`, `orch gh
ci <id> --token <t>`, then `orch factory next`. `orch gh ci` reads GitHub's checks for the exact PR
head and acts for you; read its `action`:

- `wait`: required checks are queued, running, not registered yet, or `orch` just asked GitHub to
  re-run the ones that failed (its `reason` says so; at most one re-run per head, recorded as
  `ci.rerun`). Sleep exactly the seconds in `waitSeconds` (`sleep <n>`; a minute at first, longer
  later, never more than five minutes) in a Bash call of its own, then run `orch factory next` and
  the command again in the next call: never chain the wait and the `orch` commands in one script,
  so that a session killed while waiting leaves no scheduled write behind. Do not call it in a
  tight loop. When `plan.ci.release` is true (too many pending observations in this session), the plan's
  only command is `orch job release <id> --token <t>`: run it, tell the user
  CI is still running and give the resume command, and stop; `orch factory resume` later re-reads
  GitHub and continues here.
- `complete`: required checks passed for this head and the job is `completed` in the same call;
  `orch factory next` confirms `done`. There is no separate `complete` step for `ci`: a stored
  verdict, even a passing one, is never reused, so a resumed session always runs `orch gh ci`.
- `rework`: a required check failed twice for this commit (the re-run did not change the verdict),
  or could not be re-run. `orch` saved the failing logs under `<artifactDir>/ci/<sha7>/`
  and moved the job to `build` with `plan.ci.repairs` incremented. Run the loop as usual: the build
  plan names the logs; give the builder the log paths and the failing check names, and require a
  real fix (never weakening tests, checks, `factory.json`, or CI workflows to make CI pass). The
  repair is verified, reviewed, approved, pushed to the same branch, and `orch gh pr create` reuses
  the existing PR. Then `ci` runs again.
- `exhausted` or `escalate`: the job is in `needs-human`. Report `plan.blockedReason` (the repair
  budget is spent; a check was cancelled or never reported; the PR has no checks at all or was
  closed; the branch moved outside the job) and stop, as for any `needs-human`.

Never run `gh run rerun`, `gh pr ready`, or `gh pr merge` yourself (`orch gh ci` requests the one
bounded re-run and marks a passing PR ready; report its `ready` field), and never push outside `orch gh push`. If `orch gh ci` exits 1 because GitHub or the network failed, nothing was recorded:
retry once after a minute, then release the job and report.

## 4. Report

End with: job id, stage reached, worktree and branch, review rounds and verdicts, blocking
findings left (should be none unless escalated), CI repair cycles used, PR URL and CI status
(`pending`/`passing`/`failing`/`none` as `orch` recorded it for the PR head, never "green" unless
`orch gh ci` said `passing` for the current head), and the resume command. Say "delivered" only
when the job is `completed`. Distinguish what was verified by commands from what an agent reported.

## Limits

This skill cannot restart a Claude session that stopped; it only resumes from state. Dispatch
starts sessions only through the host's documented `create_session` tool; `orch` never starts a
Claude process, and a printed fallback command is not a started session. Ownership is a
database lease: it stops two sessions from both recording changes to one job, but any process can
still write into a worktree directory it is pointed at, which is why prompts always carry the
worktree path, evidence is accepted only from a clean worktree at a recorded commit, and reviews
are fingerprint-checked. There is no daemon; nothing happens between your commands. Never archive or delete a dispatched
child's VS Code session while its job is live: VS Code removes that session's worktree, which is the
job's worktree. Stop a child with a message, or let its lease lapse.
