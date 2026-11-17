# agent-orchestrator (`orch`)

A local software factory for Claude Code. You describe a change in a VS Code chat; an independent
Claude session specifies it, implements it in its own Git worktree, runs the repository's own
checks, gets it reviewed by specialised subagents, and opens a **draft** pull request whose
required GitHub checks pass. You merge. Several jobs, in several repositories, can run at once from
one machine, and a stopped job resumes from saved state.

`orch` is the small deterministic part: a one-shot CLI over one SQLite database that holds job
state, decides which step is legal next, validates every artifact, runs the verification policy,
and records evidence pinned to commits. Claude Code sessions and their subagents do all the
creative work and interact with state only through the CLI. Nothing runs in the background
unless you opt in: the dashboard (`orch ui`) and the recovery worker (`orch recover start`) are
optional, and no job needs either.

## Why

- **Deterministic core, agentic edges.** Workflow rules live in TypeScript and are tested; prose
  for Claude describes them second. A stage completes only when its required artifact exists,
  validates, and describes the commit that is still HEAD.
- **Evidence, not claims.** Verification is executed by `orch`, running commands from a policy the
  job did not write (the scripts and tests those commands run are the job's branch, so changes to
  them are labelled for review, not trusted);
  reviews are recorded against a clean commit; delivery ends with GitHub's verdict for the exact PR
  head. A draft PR is not "done" until its required checks pass.
- **Humans keep merge authority.** The factory never merges and never force-pushes. It marks its
  draft PR ready for review only once `orch gh ci` reads passing required checks for the PR head,
  and parks on a human decision when it cannot proceed honestly. A human merges on GitHub, or by
  clicking Merge in the dashboard (`orch ui`), which merges exactly the verified head; Refresh PR
  records a merge done on GitHub. Nothing removes a job's worktree on its own: once the PR is
  merged, the dashboard offers Remove worktree (or run `orch worktree remove`); the branch is kept.
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
       └─ subagents (agents/*.md)              spec writer, challenger, builder, reviewers, approver, in the job worktree

orch ui (optional, 127.0.0.1)                  the same database, read-only plus a few human actions
orch recover start (optional)                  continues ci-stage jobs after a network outage
```

A job moves `spec → build → review → approve → pr → ci → completed`. Any stage can escalate to
`needs-human`; review rounds and CI repair cycles are bounded; `rework` sends a failed CI run or a
conflicting base integration back to `build`, where the fix is reviewed and approved again.

| Stage     | Who                                                   | Produces                                  | `orch` requires before the next stage                                                                 |
| --------- | ----------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `spec`    | `factory-spec-writer`, then `factory-spec-challenger` | `spec.md`, `spec-review-N.md`             | Goal, Scope, Acceptance criteria; the latest challenge says `VERDICT: PASS` for the current `spec.md` |
| `build`   | `factory-builder`                                     | commits, an `orch verify` run, `build.md` | clean worktree; a passing verification run for HEAD; `build.md` registered against that HEAD          |
| `review`  | 3 reviewers (7 for UI changes)                        | `round-N/review-*.md`, `consolidated.md`  | all three always-on verdicts recorded against the HEAD `build.md` describes; `BLOCKING: 0` to advance |
| `approve` | `factory-approver`                                    | `decision.md`                             | `DECISION: APPROVE` for the current HEAD; no blocking findings; verification still valid              |
| `pr`      | the coordinator                                       | base integrated, pushed branch, draft PR  | only clean base-integration merges since the approval; verified HEAD; policy unchanged                |
| `ci`      | the coordinator + `orch gh ci`                        | GitHub's verdict for the PR head          | the job's own PR; checks passed for that commit, still the approved one (plus clean base merges)      |

An independent spec challenger (Sonnet) reviews `spec.md` before anything is built; the writer
revises once on CHANGES, and a second CHANGES escalates. Reviewers are security (Opus),
correctness, and code quality (Sonnet); ui-design, ux,
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
(`orch factory start`, `next`, `resume`; see `orch factory --help`). Every job needs its request:
`--description`, or `--issue` so the description is fetched from the issue; a job with a missing or
blank description is refused (exit 2) and nothing is created.

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
existing job. `orch factory list` shows one row per job with its stage, status, whether a human is needed
(ACTION), PR, and title; `--json` adds the owner, the attached session, and the resume command for
jobs no live session holds. The host
cannot be pointed at an existing worktree, which is why `orch` lets it create one
([docs/session-launch.md](docs/session-launch.md)).

## Inspect and resume

```sh
orch factory list                     # every job, every repository
orch factory status job-1a2b3c4d      # where it is, what blocks it, next step, numbered commands
orch job events job-1a2b3c4d          # the audit log
orch verify show job-1a2b3c4d         # latest verification run and whether it still counts
orch ui                               # dashboard at http://127.0.0.1:4777/ (optional)
```

A job whose session stopped keeps its state. `/factory <id>` in any session resumes it: it takes
over the lapsed lease (a live one needs `--force`, which rotates the token so the old session's
commands fail), recreates the worktree if it is gone, re-verifies every registered artifact, and
continues from the plan. A job in `needs-human` waits: the dashboard offers the decisions the
workflow allows (resume at a stage, request review or rework, accept a proposed policy,
accept a delivery that GitHub reported no checks for, cancel), each recorded with a reason, and
never pretends to wake a session. Details: [docs/dashboard.md](docs/dashboard.md).

A network outage can stop the session driving a job. `orch recover start` (opt-in; `stop`,
`status`, `run --once`) continues the jobs `orch` can finish by itself: a `ci`-stage job with a PR
and no live owner is resumed as session `orch-recovery` once GitHub answers again, and `orch gh ci`
completes it. It never forces a live lease, never launches or messages a Claude session, and
reports jobs stalled in an agent stage as needing a session, with the resume command
([docs/workflow.md](docs/workflow.md#recovery-worker)).

## What `orch` automates and enforces

- Job state, leases, tokens, and the audit log; one owner per job; stale commands fail with exit 4.
- Artifact validation (location, structure, marker line) and registration pinned to the worktree
  HEAD; replacing registered evidence needs `--replace` and is logged.
- Verification: the committed policy, run in the clean worktree, logs saved per check; its validity
  recomputed from HEAD, tree, and policy fingerprint at every gate.
- Review rounds: security, correctness, and code-quality must all report, against the commit
  `build.md` describes; reviewers are read-only (fingerprint-checked); blocking findings or
  `CHANGES` return the job to build, until the `maxRounds`-th such rejection escalates.
- Delivery: only an approved commit (plus clean base merges) is pushed or counts as delivered; the
  draft PR is created or reused, never duplicated; the job completes only inside `orch gh ci` after
  GitHub reports passing required checks for that exact head on the job's own PR; failed checks
  get one re-run, then a repair cycle through build, review, and approval (bounded by
  `maxCiRepairs`).
- Sensitive changes (tests, CI, dependencies, the policy, and files the policy's commands run
  directly) are labelled and must be named in the consolidated review and the PR body. Labelling is
  not prevention: the policy fixes which commands run, not what the job's scripts do.
- Isolation: worktrees outside every checkout (under the data directory for jobs `orch` starts;
  VS Code's `<repo>.worktrees/<slug>` beside the repository for dispatched jobs); two jobs never
  share a worktree or branch; the primary checkout is never written to.

## What still needs a human

- Merging (on GitHub, or Merge in the dashboard). Marking a PR ready when `gh pr ready` failed
  (reported, not retried; Refresh PR records it afterwards). Fixing GitHub
  Actions itself (billing, runners, a workflow that never
  reports): `orch` escalates after one re-run.
- Accepting a verification policy a job proposed, or onboarding a repository that has none.
- Deciding on an approver's `ESCALATE`, a review round that still requests changes at the limit, a
  spent CI repair budget, a PR closed or moved outside the job.
- Restarting a stopped session: `orch` records that a lease lapsed; something must run `/factory
<id>` again (any session, or the dashboard's copyable command). The opt-in recovery worker
  continues only the `ci` stage on its own.
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
