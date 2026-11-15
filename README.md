# agent-orchestrator (`orch`)

A local software factory for Claude Code. You describe a change in a VS Code chat; an independent
Claude session specifies it, implements it in its own Git worktree, runs the repository's own
checks, gets it reviewed by specialised subagents, and opens a **draft** pull request whose
required GitHub checks pass. You merge. Several jobs, in several repositories, can run at once from
one machine, and a stopped job resumes from saved state.

`orch` is the small deterministic part: a one-shot CLI over one SQLite database that holds job
state, decides which step is legal next, validates every artifact, runs the verification policy,
and records evidence pinned to commits. Claude Code sessions and their subagents do all the
creative work and interact with state only through the CLI. Nothing runs in the background: no
daemon, no scheduler, no service.

## Why

- **Deterministic core, agentic edges.** Workflow rules live in TypeScript and are tested; prose
  for Claude describes them second. A stage completes only when its required artifact exists,
  validates, and describes the commit that is still HEAD.
- **Evidence, not claims.** Verification is executed by `orch` from a policy the job did not write;
  reviews are recorded against a clean commit; delivery ends with GitHub's verdict for the exact PR
  head. A draft PR is not "done" until its required checks pass.
- **Humans keep merge authority.** The factory never merges, never marks a PR ready, never
  force-pushes, and parks on a human decision when it cannot proceed honestly.
- **Resumable from persisted state.** Jobs recover from the database, the artifact directory, and
  Git; never from a surviving conversation.
- **Local-first.** One developer, one machine, Windows first, cross-platform by default; the only
  runtime dependency is Drizzle over Node's built-in SQLite.

## How it works

```
VS Code Agents window, any repository
  └─ /factory skill (skills/factory)        asks `orch factory next` what to do, then does it
       ├─ orch factory / job / worktree / verify / gh      one-shot CLI: open DB, one operation, exit
       │    └─ src/core (rules)  src/storage (SQLite)  src/ops (Git, GitHub, gates)
       └─ subagents (agents/*.md)              spec writer, builder, reviewers, approver, in the job worktree

orch ui (optional, 127.0.0.1)                  the same database, read-only plus a few human actions
```

A job moves `spec → build → review → approve → pr → ci → completed`. Any stage can escalate to
`needs-human`; review rounds and CI repair cycles are bounded; `rework` sends a failed CI run or a
conflicting base integration back to `build`, where the fix is reviewed and approved again.

| Stage     | Who                            | Produces                                  | `orch` requires before the next stage                                                                      |
| --------- | ------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `spec`    | `factory-spec-writer`          | `spec.md`                                 | Goal, Scope, Acceptance criteria                                                                           |
| `build`   | `factory-builder`              | commits, an `orch verify` run, `build.md` | clean worktree; a passing verification run for HEAD; `build.md` registered against that HEAD               |
| `review`  | 3 reviewers (7 for UI changes) | `round-N/review-*.md`, `consolidated.md`  | every verdict recorded against the same clean HEAD; reviewers did not write code; `BLOCKING: 0` to advance |
| `approve` | `factory-approver`             | `decision.md`                             | `DECISION: APPROVE` for the current HEAD; no blocking findings; verification still valid                   |
| `pr`      | the coordinator                | base integrated, pushed branch, draft PR  | only clean base-integration merges since the approval; verified HEAD; policy unchanged                     |
| `ci`      | the coordinator + `orch gh ci` | GitHub's verdict for the PR head          | required checks passed for exactly that commit, read by `orch gh ci` in the call that completes the job    |

Reviewers are security (Opus), correctness, and code quality (Sonnet); ui-design, ux,
accessibility, and web-platform join when the diff touches rendered UI. Models per role are
configurable. The full rules, artifact formats, event list, and CI decision table are in
[docs/workflow.md](docs/workflow.md).

## Install

Requirements: Node.js 24+, Git, the GitHub CLI (`gh auth login`), Claude Code in VS Code.

```sh
git clone https://github.com/jonborchardt/orch && cd orch
npm install && npm run build && npm link   # `orch` on PATH, running dist/
orch install                               # link skills/ and agents/ into ~/.claude
orch doctor                                # Node, Git, Claude Code, gh, paths, database, links
```

Restart Claude Code afterwards (skills are read at session start). After pulling a new version,
run `npm run build` and `orch install` again; `orch doctor` reports stale agent copies.

## Configure a repository

The factory runs only the checks a repository has committed in `factory.json`, read from the merge
base of the job branch (code the job did not write). Onboard a repository once:

```sh
cd ~/code/my-app
orch init --from-package-json      # proposes npm run check / build from package.json; or --command "test=cargo test"
cat factory.json                   # executables on PATH, argument arrays, no shell strings
git add factory.json && git commit -m "Add factory verification policy" && git push
orch init --check                  # READY, or exactly what is missing
```

```json
{
  "verification": {
    "commands": [
      { "id": "check", "command": "npm", "args": ["run", "check"] },
      { "id": "build", "command": "npm", "args": ["run", "build"] }
    ]
  }
}
```

A job that edits `factory.json` changes nothing by itself: the baseline policy keeps running, the
plan reports `policy.authorization: required`, and a human accepts or rejects the proposal from the
dashboard. A repository with no policy cannot pass the gates until one is committed on the base
branch. Details: [docs/workflow.md](docs/workflow.md#verification-evidence).

## Start a job

In a Claude Code session opened in the repository:

```
/factory Add a feature to export reports as CSV      start a job for this repository
/factory job-1a2b3c4d                                continue or adopt a job
/factory status job-1a2b3c4d                         report without changing anything
```

The session claims the job (a 30-minute lease, renewed by every command it runs), creates a worktree
under the runtime data directory on branch `factory/<id>-<slug>`, and loops on
`orch factory next <id> --json`, which returns the plan: the step, the agents to launch with their
models, the artifact each must write, the worktree state, and the exact `orch` commands to run.
Every state change is a CLI call `orch` validates. The same loop works from a shell without Claude
(`orch factory start`, `next`, `resume`; see `orch factory --help`).

## Dispatch several jobs at once

From one session in VS Code's Agents window:

```
/factory dispatch #123 in E:\code\repo-b, #45 in ..\repo-c, and this repository: add CSV export
```

For each target the skill runs `orch factory dispatch`, which checks the repository the way
`orch init --check` does and creates the job (nothing else: no claim, no worktree, no session), then
asks VS Code's `create_session` tool for an independent session on that repository with its own
worktree. The child's `/factory <id>` adopts that worktree as the job's and runs the job; the parent
goes back to its own work. Repeating a dispatch for the same repository and issue returns the
existing job. `orch factory list` shows every job with its stage, status, owner, whether a human is
needed, the attached session, PR, and the resume command for jobs no live session holds. The host
cannot be pointed at an existing worktree, which is why `orch` lets it create one
([docs/session-launch.md](docs/session-launch.md)).

## Inspect and resume

```sh
orch factory list                     # every job, every repository
orch factory status job-1a2b3c4d      # the plan: next step, blockers, evidence, commands
orch job events job-1a2b3c4d          # the audit log
orch verify show job-1a2b3c4d         # latest verification run and whether it still counts
orch ui                               # dashboard at http://127.0.0.1:4777/ (optional)
```

A job whose session stopped keeps its state. `/factory <id>` in any session resumes it: it takes
over the lapsed lease (a live one needs `--force`, which rotates the token so the old session's
commands fail), recreates the worktree if it is gone, re-verifies every registered artifact, and
continues from the plan. A job in `needs-human` waits: the dashboard offers the decisions the
workflow allows (approve back to a stage, request review or rework, accept a proposed policy,
accept a delivery that GitHub reported no checks for, cancel), each recorded with a reason, and
never pretends to wake a session. Details: [docs/dashboard.md](docs/dashboard.md).

## What `orch` automates and enforces

- Job state, leases, tokens, and the audit log; one owner per job; stale commands fail with exit 4.
- Artifact validation (location, structure, marker line) and registration pinned to the worktree
  HEAD; replacing registered evidence needs `--replace` and is logged.
- Verification: the committed policy, run in the clean worktree, logs saved per check; its validity
  recomputed from HEAD, tree, and policy fingerprint at every gate.
- Review rounds: all reviewers must report against the same commit; reviewers are read-only
  (fingerprint-checked); blocking findings or `CHANGES` return the job to build, up to `maxRounds`.
- Delivery: only an approved commit (plus clean base merges) is pushed; the draft PR is created or
  reused, never duplicated; the job completes only inside `orch gh ci` after GitHub reports
  passing required checks for that exact head; failed checks get one re-run, then one bounded
  repair cycle through build, review, and approval.
- Sensitive changes (tests, CI, dependencies, the policy) are labelled and must be named in the
  consolidated review and the PR body.
- Isolation: worktrees under the data directory, never inside a checkout; two jobs never share a
  worktree or branch; the primary checkout is never written to.

## What still needs a human

- Merging. Marking a PR ready. Fixing GitHub Actions itself (billing, runners, a workflow that never
  reports): `orch` escalates after one re-run.
- Accepting a verification policy a job proposed, or onboarding a repository that has none.
- Deciding on an approver's `ESCALATE`, a review round that still requests changes at the limit, a
  spent CI repair budget, a PR closed or moved outside the job.
- Restarting a stopped session: `orch` records that a lease lapsed; something must run `/factory
<id>` again (any session, or the dashboard's copyable command).
- Anything cooperative: subagents staying inside the worktree, reviewers reading the logs they are
  given, the parent recording the child session before the child claims the job. These are stated in
  prose and verified after the fact (fingerprints, dirty-file lists), not prevented.

## Limitations

- `orch` never starts, stops, or steers a Claude session. Dispatch relies on VS Code's documented
  `create_session`; outside the Agents window it prints the command for a human to run. Archiving a
  dispatched session in VS Code removes that session's worktree, which is the job's worktree.
- GitHub only, through `gh`; checks and commit statuses; one automatic re-run per commit; a job
  that "was not started" by Actions is indistinguishable from a failed check until a human reads the
  log, so it costs one repair cycle before escalation.
- No token or cost accounting (`orch job usage` reports measured durations and configured models).
- Private repositories on GitHub's free plan hide the required-check configuration (HTTP 403), so
  every reported check must pass there.
- The dashboard is single-user and loopback-only; it has no authentication because it has no
  network exposure.
- Ownership is advisory at the filesystem level: a process pointed at the wrong directory can
  write anywhere; `orch` refuses to count such writes as progress but cannot stop them.

## Where things live

| Purpose   | Windows                             | macOS                                | Linux                   |
| --------- | ----------------------------------- | ------------------------------------ | ----------------------- |
| config    | `%APPDATA%\orch`                    | `~/Library/Application Support/orch` | `$XDG_CONFIG_HOME/orch` |
| data      | `%LOCALAPPDATA%\orch`               | same as config                       | `$XDG_DATA_HOME/orch`   |
| database  | `<data>\orch.sqlite`                | `<data>/orch.sqlite`                 | `<data>/orch.sqlite`    |
| artifacts | `<data>\jobs\<id>\artifacts\`       | `<data>/jobs/<id>/artifacts/`        | same                    |
| worktrees | `<data>\worktrees\<repo slug>\<id>` | `<data>/worktrees/<repo slug>/<id>`  | same                    |

`ORCH_HOME=<dir>` redirects all of it (tests and side-by-side campaigns use this). Model
overrides and `maxRounds`/`maxCiRepairs` go in `<config>/factory.json` (`orch factory config`).

## More

- `orch <command> --help` for every command and option.
- [docs/workflow.md](docs/workflow.md): stages, transitions, artifacts, events, worktrees,
  verification evidence, GitHub integration, CI reconciliation, ownership.
- [docs/dashboard.md](docs/dashboard.md): the dashboard's views, actions, and security model.
- [docs/development.md](docs/development.md): stack, layout, build, tests, migrations, install
  mechanics, Windows notes, CLI reference. `CLAUDE.md` has the rules for changing the code.
- [docs/decisions/](docs/decisions/): one file per architectural decision.
- [docs/session-launch.md](docs/session-launch.md) and
  [docs/phase3-validation.md](docs/phase3-validation.md): what VS Code can and cannot do about
  independent sessions, and the concurrent-job validation that exercised it.
