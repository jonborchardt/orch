# agent-orchestrator

A local, multi-repository AI software factory driven by Claude Code.

One global installation serves any number of project repositories. A globally installed Claude
skill starts a factory job from a Claude Code session in any repo. Each job owns a Git worktree and
a primary Claude session, which delegates planning, implementation, testing, and review to
specialized subagents. The workflow moves through deterministic states enforced by TypeScript, with
shared state in a single local SQLite database and a CLI (`orch`) that agents and humans both use.
Output is a draft GitHub PR; humans keep merge authority.

**Status:** Phase 3B. The factory works end to end from any repository: the global `/factory`
skill coordinates ten source-controlled subagents (spec writer, builder, seven reviewers, approver)
through the deterministic `orch` CLI. Durable core (SQLite, state machine, events, leases),
per-job Git worktrees, content-validated artifacts, GitHub delivery via `gh`, `orch factory` for
start/plan/resume, and `orch install` for Windows-safe global installation are in place. There is no
dashboard yet. See [Limits of Phase 3B](#limits-of-phase-3b).

## Architecture

```
VS Code + Claude Code session (any repository)
  └─ /factory skill (skills/factory)    runs `orch factory next` and does what the plan says
       ├─ orch factory ...             start / next / resume / check-readonly / config (src/ops/factory.ts)
       ├─ orch job ...                  one-shot CLI: open DB, one deterministic op, print, exit
       │    ├─ src/core/workflow.ts     legal transitions, required artifacts, review rounds
       │    ├─ src/core/artifact-rules.ts  required sections and VERDICT/DECISION markers
       │    ├─ src/core/roles.ts        roles -> agents -> default models; UI reviewer detection
       │    ├─ src/core/ownership.ts    who may mutate a job right now
       │    └─ src/storage/            SQLite (node:sqlite + Drizzle), migrations, queries
       ├─ orch worktree ...            one isolated Git worktree + branch per job (src/ops, src/git)
       ├─ orch gh ...                  issues, push, draft PR, CI status via gh (src/ops, src/integrations)
       └─ subagents (agents/*.md)       spec writer, builder, reviewers, approver in the job's worktree
```

Responsibilities:

- **Claude** performs the work: writes specs, code, tests, reviews, and PR text.
- **`orch`** owns durable state, concurrency control, validation, and workflow decisions. It
  returns structured results telling the skill what stage comes next and what it requires.
- **The database** (`orch.sqlite`) is shared by every repository and every session on the machine.
  Any session can inspect it and adopt an interrupted job; a future dashboard reads it too.

`orch` is not a service. It runs no daemon, server, scheduler, or background work. Every command
starts, does one thing, and exits.

## Principles

- **Deterministic core, agentic edges.** State transitions and rules live in code. LLM sessions do
  the creative work and interact with state only through the CLI.
- **No separate LLM supervisor.** Claude Code sessions and their subagents are the workers; this
  project supplies instructions, rules, state, and tooling.
- **Resumable from persisted state.** Jobs recover from the database, artifacts, and Git, never
  from a surviving conversation.
- **Local-first, one developer, one machine.** Windows + VS Code first, cross-platform by default.
- **Minimal dependencies.** Node built-ins before libraries, libraries before frameworks.

## Stack

| Concern       | Choice                                                             |
| ------------- | ------------------------------------------------------------------ |
| Runtime       | Node.js >= 24, ESM, TypeScript strict                              |
| Dev execution | `node src/cli/main.ts` via Node's native type stripping (no `tsx`) |
| Build         | `tsc` to `dist/`                                                   |
| Tests         | Vitest with V8 coverage                                            |
| Lint / format | ESLint (typescript-eslint, type-checked) + Prettier                |
| CLI parsing   | `node:util` `parseArgs`                                            |
| Persistence   | built-in `node:sqlite` + Drizzle ORM / Drizzle Kit (`1.0.0-rc.5`)  |
| Dashboard     | Deferred; planned React + Vite + Material UI under `web/`          |

Runtime dependencies: `drizzle-orm` only. See `docs/decisions.md` for why the rc is pinned.

## Layout

```
src/
  cli/           main.ts (arg parsing, dispatch), doctor.ts, job.ts, worktree.ts, gh.ts,
                 install.ts, output.ts
  core/          workflow.ts, artifact-rules.ts, ownership.ts, errors.ts, paths.ts, exec.ts
  storage/       schema.ts, client.ts, jobs.ts, events.ts, artifacts.ts   (only SQLite importer)
  git/           run.ts (git with arg arrays), repo.ts (queries), worktree.ts (worktree ops)
  integrations/  claude.ts (skill/agent linking), github.ts (gh CLI wrapper)
  ops/           worktree.ts, github.ts: ownership check -> Git/gh action -> storage record
drizzle/         generated SQL migrations + snapshots (committed, shipped)
drizzle.config.ts
tests/           Vitest suites, mirror src/; helpers.ts has shared fixtures
docs/decisions.md
.github/workflows/ci.yml
```

```
skills/factory/  SKILL.md (the coordinator), reference.md (agent inputs, artifact templates)
agents/          factory-spec-writer, factory-builder, factory-reviewer-{security,correctness,
                 code-quality,ui-design,ux,accessibility,web-platform}, factory-approver
```

Planned, created when first needed: `web/` (dashboard).

## Using the factory

One-time setup on a machine:

```sh
git clone <this repo> && cd agent-orchestrator
npm install && npm link       # `orch` on PATH
orch install                  # link skills/ and agents/ into ~/.claude (see Global Claude skills)
gh auth login                 # only needed for the draft PR at the end
```

Restart Claude Code (skills are read at session start), open any project repository, and:

```
/factory Add a feature to export reports as CSV      start a job for this repository
/factory job-1a2b3c4d                                continue or adopt a job
/factory status job-1a2b3c4d                         report without changing anything
/factory resume job-1a2b3c4d                         same as the bare id
```

The same thing from a shell, without Claude:

```sh
cd ~/code/my-app
orch factory start --title "Export reports as CSV" --session me --json   # job, token, worktree, plan
orch factory next job-1a2b3c4d --json                                     # what to do now
orch factory status job-1a2b3c4d                                          # read-only summary
orch factory resume job-1a2b3c4d --session me-2 [--force] [--to <stage>]  # adopt from saved state
orch factory config                                                       # role -> model, config path
```

### How a job runs

```
request ─→ spec ─→ build ─→ review (N reviewers in parallel) ─┬─ all PASS ─→ approve ─┬─ APPROVE ─→ pr ─→ done
                     ▲                                       │                      └─ ESCALATE ─→ needs-human
                     └──────── any CHANGES (round < max) ◀───┘   round == max ─→ needs-human
```

The coordinating Claude session owns the job (a lease with a token) and loops on
`orch factory next <id> --json`, which returns a **plan**: the step (`run-stage`, `create-worktree`,
`resume`, `needs-human`, `done`, `cancelled`), the agents to launch with their models and the
artifact each must write, the registered artifacts re-verified against disk, the worktree state
(branch, HEAD, dirty files, commits and changed files vs base, a fingerprint), and the exact `orch`
commands to run, in order. The skill substitutes the token and runs them. Every state change is a
CLI call that `orch` validates; the skill never edits the database or workflow tables.

| Stage     | Agent(s)                      | Produces                                         | `orch` checks before advancing                                                                                  |
| --------- | ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `spec`    | `factory-spec-writer` (Opus)  | `spec.md`                                        | Goal, Scope, Acceptance criteria present                                                                        |
| `build`   | `factory-builder` (Opus)      | commits on the job branch + `build.md`           | Summary, Validation present; round > 1 needs `--replace`                                                        |
| `review`  | reviewers below, concurrently | `round-N/review-<r>.md` each + `consolidated.md` | every reviewer has a verdict matching its `VERDICT:` line; `BLOCKING: n`; worktree unchanged (`check-readonly`) |
| `approve` | `factory-approver` (Opus)     | `decision.md`                                    | `DECISION: APPROVE`; `ESCALATE` forces `escalate`                                                               |
| `pr`      | the coordinator + `orch gh`   | pushed branch, draft PR, `pr.md`                 | branch pushed and current, repo identity, base on origin, PR recorded                                           |

Reviewers always include **security** (Opus), **correctness**, and **code-quality** (Sonnet). When
the job's diff touches rendered UI (`.tsx`, `.vue`, `.css`, `.html`, ... per
`uiPatterns`), **ui-design**, **ux**, **accessibility**, and **web-platform** (Sonnet) join;
`--ui`/`--no-ui` on `factory next` overrides detection. Reviewers are read-only on code (their
tools exclude `Edit`), must cite evidence they gathered rather than trusting `build.md`, report only
inside their ownership and the spec's scope, and end their file with `VERDICT: PASS|CHANGES`. The
coordinator deduplicates findings into `round-N/consolidated.md`; any `CHANGES` returns the job to
`build` with that file as input, up to `maxRounds` (default 3), after which `orch` escalates to
`needs-human` instead of approving.

The approver reads the spec, `build.md`, the full diff, every review, and reruns validation before
writing `decision.md`. Approval permits a draft PR; it never merges. In the `pr` stage the plan says
to integrate `origin/<base>` first if it advanced (then re-validate), push, create or reuse the draft
PR with `pr.md` as the body, and record it. A recorded draft PR with `ciStatus: pending` is reported
as exactly that.

### Model configuration

Defaults live in `src/core/roles.ts` and in each agent's frontmatter; the plan carries the model
per agent so the skill can pass it to the subagent tool. Override per machine in
`<config>/factory.json` (path from `orch factory config`):

```json
{
  "models": { "security": "sonnet", "builder": "opus" },
  "uiPatterns": ["\\.(tsx|jsx|css)$"],
  "maxRounds": 2
}
```

Models are `opus`, `sonnet`, `haiku`, or `inherit`; unknown roles, models, keys, or invalid
regexes are rejected.

### Resume and recovery

A job is recoverable from the database, its artifact directory, and its worktree; the original
conversation is not needed. `orch factory resume <id> --session <name>`:

1. Claims the job (takes over a lapsed lease; needs `--force` against a live one, which rotates the
   token so the previous session's commands fail with exit 4). A job that was `running` under the
   previous owner becomes `interrupted` and is put back to `pending` for its current stage.
2. Recreates the worktree from the surviving branch if the directory is gone.
3. Re-verifies every registered artifact (exists, same hash) and reports problems in the plan.
4. Returns the plan, so the new session continues exactly where the state says.

`needs-human` jobs stay blocked until a person decides; `resume --to <stage>` sends them back.
`orch factory check-readonly` guards review rounds: the plan's worktree fingerprint (HEAD plus
dirty files) must be unchanged after reviewers ran.

**Limits.** A skill cannot restart a Claude session that stopped, and there is no daemon: a lapsed
lease is noticed only when someone runs `orch factory next` or `resume`. Ownership is advisory at
the filesystem level (see [Worktrees](#worktrees)). Subagent APIs differ between harnesses; the
skill explains how to fall back to inline prompts or sequential self-execution and asks the
coordinator to say so in its report.

## Install and develop

```sh
git clone <this repo> && cd agent-orchestrator
npm install            # also builds dist/ via the prepare script
npm link               # puts `orch` on PATH from any directory
orch doctor
```

`npm link` creates a global shim pointing at `dist/cli/main.js`, so run `npm run build` after
changing source. During development, run from source without building:

```sh
npm run dev -- doctor
node src/cli/main.ts job list --json
```

Both work from any directory. Repository detection uses the invoking directory, never the install
location.

### Validation

```sh
npm run check          # typecheck + lint + format:check + test
npm run test:coverage  # coverage report (text + lcov in coverage/)
npm run db:check       # validate committed migrations
npm run format         # apply Prettier
npm run build
```

CI runs the same commands on Ubuntu and Windows, fails if `src/storage/schema.ts` has changes
without a committed migration, and initializes a database from `dist/` outside the repository.

## Runtime paths

All mutable state lives under per-user OS directories, never inside this package, a Claude skill
directory, or a project repository. Set `ORCH_HOME` to redirect everything to one directory (used
by tests and for side-by-side development installs).

| Purpose    | Windows                             | macOS                                | Linux                   |
| ---------- | ----------------------------------- | ------------------------------------ | ----------------------- |
| config     | `%APPDATA%\orch`                    | `~/Library/Application Support/orch` | `$XDG_CONFIG_HOME/orch` |
| data       | `%LOCALAPPDATA%\orch`               | same as config                       | `$XDG_DATA_HOME/orch`   |
| database   | `<data>\orch.sqlite`                | `<data>/orch.sqlite`                 | `<data>/orch.sqlite`    |
| artifacts  | `<data>\jobs\<id>\artifacts\`       | `<data>/jobs/<id>/artifacts/`        | same                    |
| worktrees  | `<data>\worktrees\<repo slug>\<id>` | `<data>/worktrees/<repo slug>/<id>`  | same                    |
| logs / tmp | `<data>\logs`, `<data>\tmp`         | `<data>/logs`, `<data>/tmp`          | same                    |

Five locations stay distinct: the install root (this package, read-only), the runtime data
directory above, the repository the CLI was invoked from, a job's worktree, and a job's artifact
directory. `orch doctor` prints the first three and the database path.

## Database and migrations

`src/storage/schema.ts` is the schema, in TypeScript. `npm run db:generate` turns changes into a
timestamped SQL migration under `drizzle/`, which is committed and included in the package `files`.
Whenever the CLI opens the database it enables WAL mode, foreign keys, and a 5 s busy timeout, then
applies any migrations not yet recorded in `__drizzle_migrations`. A fresh machine gets a complete
database on first use; an existing database is upgraded in place. Nothing ever deletes, resets, or
recreates a database, and `drizzle-kit push` is never used.

Tables:

| Table       | Purpose                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `jobs`      | One row per job: identity, repo, branch, worktree, stage, status, round, owner lease, PR, CI, rev. |
| `events`    | Append-only activity log (`type`, JSON `payload`, `actor`, timestamp) per job                      |
| `artifacts` | Registered artifact files: relative path, stage, round, size, sha256, parsed marker                |
| `reviews`   | One row per reviewer per round: verdict (`pass`/`changes`/pending), artifact, summary              |

`jobs.worktreePath` and (`repo`, `branch`) are unique, so a managed worktree or branch belongs to
at most one job.

All writes happen in `BEGIN IMMEDIATE` transactions, so concurrent `orch` processes queue on
SQLite's write lock instead of corrupting state. Every job mutation increments `jobs.revision`.

## Workflow

```
spec → build → review → approve → pr → completed
                 │  changes            │
                 └──────→ build        └─ (requires a recorded PR)
         any stage ── escalate ──→ needs-human ── resume --to <stage> ──→ back
```

**Stage** is where the job is; **status** is what is happening there:
`pending`, `running`, `blocked`, `interrupted`, `completed`, `failed`, `cancelled`.

Claude requests an action; `orch job transition <id> <action>` validates and applies it:

| Action     | Allowed when                                              | Effect                                                  |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `start`    | status `pending`, `failed`, or `interrupted`              | status `running`                                        |
| `complete` | status `running` and required artifact registered         | next stage, status `pending` (see below)                |
| `fail`     | status `running`                                          | status `failed`                                         |
| `escalate` | any live stage                                            | stage `needs-human`, status `blocked`, remembers origin |
| `resume`   | `needs-human`, or status `interrupted`/`failed`/`blocked` | back to the origin or `--to` stage, status `pending`    |
| `cancel`   | any job not already finished                              | status `cancelled`                                      |

Required artifacts, relative to the job's artifact directory and registered with
`orch job artifact add`: `spec.md`, `build.md`, `round-N/consolidated.md`, `decision.md`, `pr.md`.
Registration checks the file is inside the artifact directory (no absolute paths or `..`), is
`.md`, exists, is non-empty, and has the structure its path requires (`src/core/artifact-rules.ts`):

| Artifact                   | Required headings                | Marker line (exactly once)        |
| -------------------------- | -------------------------------- | --------------------------------- |
| `spec.md`                  | Goal, Scope, Acceptance criteria |                                   |
| `build.md`                 | Summary, Validation              |                                   |
| `round-N/review-<name>.md` | Findings                         | `VERDICT: PASS` or `CHANGES`      |
| `round-N/consolidated.md`  | Findings                         | `BLOCKING: <count>`               |
| `decision.md`              | Rationale                        | `DECISION: APPROVE` or `ESCALATE` |
| `pr.md`                    | Validation, Known limitations    |                                   |

Headings match case-insensitively at any level. The marker is stored on the artifact row and the
workflow reads it: `review record --verdict pass` is refused if the file says `CHANGES`, and
`approve` cannot complete unless `decision.md` says `APPROVE` (use `escalate` instead). Files with
other names (evidence, notes) are accepted without structure checks. A file on disk is not evidence
of completion until it is registered.

**Replacement is explicit.** Registering the same path with identical content is a no-op.
Registering changed content fails unless `--replace` is given, and is then logged as
`artifact.replaced` with the previous hash, so the history of what was accepted survives. Combine
with `--revision <n>` to also reject the replacement if the job moved on meanwhile. Review files are
per round (`round-N/`) and are never overwritten by later rounds.

**Review rounds.** Completing `build` increments the round and enters `review`. While `review` is
`running`, each reviewer is recorded with `orch job review record` (without a verdict while it
runs, then with `--verdict pass|changes`). `complete` is refused while any reviewer is pending.
If every verdict is `pass` the job moves to `approve`; if any is `changes` it returns to `build`,
unless the round equals `--max-rounds` (default 3), in which case it escalates to `needs-human`.

**PRs.** `orch job pr <id> --url <u> --state draft|ready|merged` records the PR; the `pr` stage
cannot complete without one. The state can be updated later (draft → ready → merged) without
changing the workflow, since the factory's deliverable is a draft PR.

Every accepted change appends events (`job.created`, `job.claimed`, `job.released`,
`stage.started`, `stage.completed`, `stage.failed`, `artifact.registered`, `artifact.replaced`,
`review.recorded`, `job.blocked`, `job.resumed`, `job.interrupted`, `job.cancelled`,
`job.completed`, `worktree.created`, `worktree.adopted`, `worktree.removed`,
`worktree.integrated`, `branch.pushed`, `pr.recorded`, `ci.observed`) in the same transaction.
`orch job events <id>` lists them.

## Worktrees

Each job gets one isolated Git worktree and branch, created from the job's base branch:

```sh
orch worktree create <id>            # <data>/worktrees/<repo slug>/<id>, branch factory/<id>-<title slug>
orch worktree show <id>              # branch, HEAD, dirty files, commits and changed files vs base
orch worktree adopt <id> --path <d>  # record an existing worktree of the same repository instead
orch worktree integrate <id>         # merge origin/<base> (or local base) into the job branch
orch worktree remove <id>            # delete the directory; refused while dirty; branch is kept
```

- Worktrees live under the runtime data directory, never inside a project checkout, and many
  repositories and jobs coexist (`worktrees/github.com-acme-alpha/job-1a2b3c4d`).
- `create` is idempotent: an existing worktree on the right branch is confirmed, a directory that
  vanished is recreated on the surviving branch, and a foreign directory at the path is an error.
  The checkout used is the job's recorded `repoPath` (or `--repo <other clone>`), and its identity
  (normalized `origin` URL) must match the job's repository.
- `adopt` validates that the directory is the top level of a worktree of the same repository, on a
  branch, and not the primary checkout. Two jobs can never share a worktree or a branch; the
  database refuses it.
- `remove` and `integrate` refuse to run over uncommitted changes; `integrate` aborts cleanly on a
  conflict and reports the files, leaving the worktree exactly as it was. The branch and its
  commits are always preserved; `orch` never deletes uncommitted or unpushed work.
- `create`, `adopt`, `remove`, and `integrate` require the job's owner token; `show` is read-only.

**Ownership is advisory at the filesystem level.** The CLI enforces that only the owner records
changes about a job, but any process with filesystem access (including a subagent pointed at the
wrong directory) can write into another job's worktree. Skills therefore pass the worktree path
explicitly to every subagent and compare `orch worktree show` before and after read-only steps.

## GitHub integration

`orch gh` wraps the GitHub CLI (`gh`, authenticated with `gh auth login`). No GitHub SDK, no
tokens handled by `orch`.

```sh
orch gh repo [--repo <path>]            # nameWithOwner, default branch, identity for a checkout
orch gh issue <#N|N|url> [--repo <path>]
orch gh push <id>                       # git push --set-upstream origin <job branch>; never force
orch gh pr create <id> --body-file <md> [--title <t>]   # draft PR, or the existing open one
orch gh pr status <id>                  # state, draft/ready/merged, CI rollup; recorded with --token
```

Before creating a PR, `orch` checks that the job is in the `pr` stage, that GitHub's repository
for the checkout matches the job's identity, that the base branch exists on `origin`, and that the
job branch is pushed and `origin/<branch>` equals the worktree HEAD. An open (or merged) PR for the
branch with the same base is reused instead of creating a duplicate. The PR is recorded on the job
(`prUrl`, `prState`) together with the CI rollup (`ciStatus`: `none`, `pending`, `passing`,
`failing`). `orch` never merges, force-pushes, or marks a PR ready; a recorded draft PR is not a
passing CI run.

Tests never call GitHub: setting `ORCH_GH_SHIM=<file.cjs>` makes `orch` run `node <file> <args>`
instead of `gh`, and the suite uses a stateful shim plus a local bare repository as `origin`.

## Ownership and resumability

Several VS Code sessions may run at once, so each job has at most one owner.

- `orch job claim <id> --session <name>` atomically takes the job and returns a **token**. The lease
  lasts `--lease` minutes (default 30). Pass the token as `--token` or `ORCH_TOKEN` on every
  mutation; `ORCH_SESSION` can stand in for `--session`.
- **Renewal is explicit.** There is no daemon. Every successful mutation by the token holder extends
  the lease by the claimed length, and `claim` again from the same session renews it without
  changing the token. A session that goes quiet simply lets the lease lapse.
- **Expiry and takeover.** Another session may claim an expired lease, or any lease with `--force`.
  Takeover rotates the token, so commands from the previous owner fail with exit code 4, and marks
  a `running` job `interrupted` so it must be explicitly resumed.
- **`orch job resume <id> --session <name>`** claims the job and, if it was interrupted, failed,
  blocked, or in `needs-human`, puts it back to `pending` (use `--to <stage>` from `needs-human`).
  It returns the full job detail: artifacts, reviews, recent events, and the artifact directory.
  Registered artifacts from completed stages are preserved, so a new session can continue without
  the original conversation.
- **`--revision <n>`** on any mutation rejects the command if the job has changed since the caller
  last read it (optimistic concurrency). Re-registering the same artifact or reviewer is idempotent;
  repeating `start` on a running stage is refused.
- `orch job release <id>` gives the job up voluntarily.

## CLI reference

Global flags: `--json` (machine output; errors become `{"error":{...}}` on stderr), `--help`,
`--version`. Exit codes: 0 success; 1 failed check, validation error, or illegal transition;
2 usage error; 3 not found; 4 ownership (another owner, bad or stale token, stale revision).

```
orch doctor
orch install [--dry-run] [--source <dir>] [--claude-dir <dir>]

orch job create    --title <t> [--description <d>] [--issue <ref>] [--repo <path>] [--base <branch>]
                   [--max-rounds <n>]
orch job list      [--repo <path|identity>] [--status <s>] [--stage <s>]
orch job show      <id>
orch job events    <id> [--limit <n>]
orch job claim     <id> --session <name> [--lease <minutes>] [--force]
orch job release   <id> --token <t>
orch job resume    <id> --session <name> [--to <stage>] [--force]
orch job transition <id> start|complete|fail|escalate|resume|cancel --token <t>
                   [--to <stage>] [--reason <r>] [--revision <n>]
orch job artifact add <id> <relative-path> --token <t> [--replace] [--revision <n>]
orch job review record <id> --reviewer <name> [--verdict pass|changes] [--artifact <path>]
                   [--summary <s>] --token <t>
orch job pr        <id> --url <url> --state draft|ready|merged --token <t>

orch worktree create|show|adopt|remove|integrate <id> [--path <dir>] [--repo <clone>] --token <t>
orch gh repo | issue <ref> | push <id> | pr create <id> --body-file <md> | pr status <id>

orch factory start  --title <t> | --issue <ref> [--description <d>] [--repo <path>] [--base <b>]
                    [--max-rounds <n>] --session <name> [--ui|--no-ui]
orch factory next|status <id> [--ui|--no-ui]
orch factory resume <id> --session <name> [--to <stage>] [--force]
orch factory check-readonly <id> --fingerprint <f>
orch factory config
```

`job create` detects the repository from the current directory (or `--repo`), records its identity
(normalized `origin` URL, e.g. `github.com/org/repo`, or the directory name) and current branch,
and does not need GitHub: `--issue` is an opaque reference.

Mutation commands return the resulting state plus what comes next:

```json
{
  "jobId": "job-3f9a1c2e",
  "stage": "build",
  "status": "pending",
  "revision": 5,
  "next": { "stage": "build", "status": "pending", "requiredArtifacts": ["build.md"] },
  "artifactDir": "C:\\Users\\me\\AppData\\Local\\orch\\jobs\\job-3f9a1c2e\\artifacts",
  "job": { "...": "full row" }
}
```

A typical session:

```sh
cd ~/code/my-app
orch job create --title "Add rate limiting" --json          # -> jobId
orch job claim job-3f9a1c2e --session vscode-1 --json         # -> token
export ORCH_TOKEN=...
orch job transition job-3f9a1c2e start
# ... write <artifactDir>/spec.md ...
orch job artifact add job-3f9a1c2e spec.md
orch job transition job-3f9a1c2e complete --json              # next: build, requires build.md
```

## Global Claude skills

Skills and subagent definitions are source-controlled under `skills/<name>/SKILL.md` and
`agents/<name>.md`. `orch install` links them into the user's global Claude configuration
(`~/.claude`, or `CLAUDE_CONFIG_DIR`, or `--claude-dir`):

- `~/.claude/skills/<name>` → `<install root>/skills/<name>` as a directory junction on Windows
  (`fs.symlink(..., 'junction')`, no admin or Developer Mode) and a symlink elsewhere. Live.
- `~/.claude/agents/<name>.md` → `<install root>/agents/<name>.md`, trying in order: a file symlink
  (live; needs Developer Mode or elevation on Windows), a hard link (live; same volume only), and
  finally a **managed copy** ending in `<!-- orch-managed-copy: <source> -->`. Copies are not
  live: `orch install --dry-run` reports them as `stale` when the source changed and `orch install`
  refreshes them. Only files carrying that marker for this source are ever rewritten.

The installer never overwrites anything it does not own and is safe to repeat: existing links or
fresh copies are `linked`, anything else at a target path is a `conflict` that is left alone and
makes the command exit 1. `--dry-run` shows the plan. It never touches a project's `CLAUDE.md`,
`.claude/`, or other global skills, and no plugin or marketplace is involved.

Limitations: Claude Code reads `~/.claude/skills` and `~/.claude/agents` when a session starts, so
restart the session (or VS Code window) after installing. Discovery depends on Claude Code following
links, which it does for junctions and symlinks; if a skill is not listed, check `orch install
--dry-run` output and the resolved target.

## Windows considerations

- Runtime data goes to `%LOCALAPPDATA%\orch`; config to `%APPDATA%\orch`.
- Tools are started with argument arrays. npm-installed `.cmd` shims cannot start without
  `cmd.exe`, so `src/core/exec.ts` runs only those through `cmd.exe /d /s /c` with a quoted
  absolute path and fixed arguments. Nothing user-supplied reaches a shell.
- Artifact paths are stored with forward slashes regardless of how they were typed.
- SQLite WAL leaves `orch.sqlite-wal` / `-shm` beside the database while connections are open.
- Skill links are junctions; agent links fall back to hard links, then managed copies, without
  Developer Mode (a repo on `E:` and `~/.claude` on `C:` ends up with copies).
- Worktree and repository paths are compared case-insensitively after `realpath`; paths with
  spaces work everywhere because nothing goes through a shell.
- Shells started by Claude Code do not keep environment variables between calls, so the plan's
  commands carry `--token <token>` explicitly instead of relying on `ORCH_TOKEN`.

## Limits of Phase 3B

Implemented: everything in Phase 3A plus `orch factory`, the `/factory` skill, ten agent
definitions, model configuration, UI reviewer detection, read-only fingerprinting, resume from
persisted state, and contract tests that drive the workflow with fixture subagent outputs (spec to
build, malformed output, parallel review aggregation, rework rounds, max-round escalation, approval
and rejection, resume after interruption, draft PR through the mocked `gh`, cross-project jobs,
ownership loss, configuration).

Not implemented: the dashboard (Phase 4), Claude session spawning or restoration, token accounting,
any daemon or scheduler, automatic crash recovery (a lapsed lease is only noticed when someone runs
`factory next` or `resume`), rebase-based integration (only merge commits), a workflow definition
language, and plugin distribution. Ordinary CI never calls a model: the skill and agents are
exercised by their contracts (frontmatter, templates, commands), and a live run requires a Claude
Code session. The `events` table is an audit log, not an event-sourcing store. See
`docs/decisions.md` for the reasoning behind what exists.
