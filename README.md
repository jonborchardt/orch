# agent-orchestrator

A local, multi-repository AI software factory driven by Claude Code.

One global installation serves any number of project repositories. A globally installed Claude
skill starts a factory job from a Claude Code session in any repo. Each job owns a Git worktree and
a primary Claude session, which delegates planning, implementation, testing, and review to
specialized subagents. The workflow moves through deterministic states enforced by TypeScript, with
shared state in a single local SQLite database and a CLI (`orch`) that agents and humans both use.
Output is a draft GitHub PR; humans keep merge authority.

**Status:** Phase 5 complete. The factory works end to end from any repository: the global
`/factory` skill coordinates ten source-controlled subagents (spec writer, builder, seven
reviewers, approver) through the deterministic `orch` CLI. Durable core (SQLite, state machine,
events, leases), per-job Git worktrees, content-validated artifacts pinned to commits, executed
verification evidence (`orch verify`), sensitive-change labelling, recorded base integration,
GitHub delivery via `gh`, `orch factory` for start/plan/resume, `orch install` for Windows-safe
global installation, and an optional local dashboard (`orch ui`, React + Vite + Material UI over
the shared database) are in place. See [Limits](#limits).

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

orch ui (optional, loopback)            src/server: JSON API + web/dist; actions reuse src/ops/actions.ts
  └─ browser: web/ (React + MUI)        job board, job detail, human controls; reads the same database
```

Responsibilities:

- **Claude** performs the work: writes specs, code, tests, reviews, and PR text.
- **`orch`** owns durable state, concurrency control, validation, and workflow decisions. It
  returns structured results telling the skill what stage comes next and what it requires.
- **The database** (`orch.sqlite`) is shared by every repository and every session on the machine.
  Any session can inspect it and adopt an interrupted job; the dashboard reads it too.

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
| Dashboard     | React 19 + Vite + Material UI under `web/`, served by `node:http`  |
| Browser tests | Playwright (Chromium) against a real `orch ui`                     |

Runtime dependencies: `drizzle-orm` only; the dashboard's React/MUI are build-time inputs whose
output (`web/dist`) ships prebuilt. See `docs/decisions.md` for why the rc is pinned.

## Layout

```
src/
  cli/           main.ts (arg parsing, dispatch), args.ts (option helpers), output.ts, doctor.ts,
                 job.ts, worktree.ts, gh.ts, verify.ts, factory.ts, ui.ts, install.ts
  core/          workflow.ts, artifact-rules.ts, roles.ts, ownership.ts, verification.ts,
                 sensitive.ts, errors.ts, paths.ts, exec.ts
  storage/       schema.ts, client.ts, jobs.ts, events.ts, artifacts.ts, verification.ts
                 (only SQLite importer)
  git/           run.ts (git with arg arrays), repo.ts (queries), worktree.ts (worktree ops)
  integrations/  claude.ts (skill/agent linking), github.ts (gh CLI wrapper)
  ops/           worktree.ts, github.ts, verify.ts (runs the policy), gates.ts (Git-aware gates),
                 tree.ts, factory.ts (the plan), actions.ts (dashboard actions)
  server/        http.ts (loopback server, guards, static), api.ts (read models), types.ts (shared)
web/             Vite + React + MUI dashboard: index.html, src/*.tsx, vite.config.ts -> web/dist
drizzle/         generated SQL migrations + snapshots (committed, shipped)
drizzle.config.ts
tests/           Vitest suites, mirror src/; helpers.ts (fixtures), drive.ts (stage driver),
                 fixtures/dashboard.ts (seeded dashboard state)
e2e/             Playwright browser checks for the dashboard (playwright.config.ts)
scripts/         seed-dashboard.ts (demo data into a scratch ORCH_HOME)
docs/decisions.md
.github/workflows/ci.yml
```

```
skills/factory/  SKILL.md (the coordinator), reference.md (agent inputs, artifact templates)
agents/          factory-spec-writer, factory-builder, factory-reviewer-{security,correctness,
                 code-quality,ui-design,ux,accessibility,web-platform}, factory-approver
```

## Dashboard

`orch ui` is optional. Factory jobs never need it; it reads the same shared database and job
artifacts that the CLI writes and offers the few human decisions the workflow has.

```sh
orch ui                 # http://127.0.0.1:4777/ until Ctrl+C
orch ui --port 0 --open # free port, open the browser
ORCH_HOME=/tmp/demo npm run ui:seed && ORCH_HOME=/tmp/demo orch ui   # representative demo data
```

**Job board** (all repositories): repository, title and id, stage, status, session, branch and
worktree, review round, per-reviewer verdicts for the current round, blocking-finding count from
the latest consolidation, elapsed time, last update, PR link and CI rollup. The stage column is the
workflow position; the status column is the execution state, kept separate so a job stopped in
`build` never reads as done. Its states (each with a glyph and label, never colour alone):
`running (lease live)` means a session renewed its lease recently; `last reported running` means
the status is still `running` but the lease lapsed, so the session is presumed gone;
`interrupted`, `failed`, `needs human`, `idle` (pending), `completed`, and `cancelled`, which is
grey and never styled like a success. Under the chip, one line says why a stopped job stopped,
derived from persisted fields only (`src/server/status.ts`): the latest `job.blocked`,
`stage.failed`, `job.interrupted`, or `job.cancelled` event and its recorded reason, the
`decision.md` marker, the consolidation's BLOCKING count, and the newest verification run. When
the state does not classify an escalation the line says so (`Escalated from build`) rather than
guessing. Jobs a session may resume get a **Copy resume** control. Filter by repository and by
active / needs human / finished / cancelled; the page refreshes every few seconds while visible.

**Job detail** (`#/jobs/<id>`): next step and agents from the plan, the request, and tabs for the
spec, build summary, review history per round (verdict, summary, full review text), consolidated
findings per round, the approval decision, registered artifacts (size, marker, hash), the event
log, Git state (branch, HEAD, ahead/behind base, commits, changed files, uncommitted files), and
the PR with its CI status. Buttons open the worktree in VS Code (`vscode://file/...`) and the PR on
GitHub. A status panel above the controls repeats the board's explanation with the full recorded
reason and a **Resume** block. When no live lease is held (unowned, lapsed lease, interrupted,
failed, or released at `needs-human`) it shows the `/factory resume <id>` command with a copy
button, the checkout to run it in (the repository the job was started from, with an "open in VS
Code" link), and the note that copying changes nothing; only a Claude Code session opened in that
checkout resumes the job. While any session holds a live lease the command is withheld and the
holder is named, because `orch factory resume` would be refused without a deliberate `--force`;
the dashboard never forces ownership.

**Controls** reuse `src/ops/actions.ts`, which runs the same validated transitions as the CLI as a
short-lived `dashboard` session and then releases the job. The detail API lists the actions the
workflow allows in the current state (`allowedActions`) and the client renders only those; the
server re-checks every request. Approve is the primary control only when the approver escalated
(`decision.md` says ESCALATE); for any other blocker it is demoted behind a warning, because
approving moves the job without fixing anything. Request rework is primary only when reviewers
still requested changes at the last allowed round, which is where the workflow itself would go
back to `build`; for interruptions, verification failures, and unclassified escalations every
control stays neutral, since the right transition is a human call.

| Action                     | Allowed when                    | Effect                                              |
| -------------------------- | ------------------------------- | --------------------------------------------------- |
| Approve                    | stage `needs-human`             | `resume --to <stage>` (default: where it came from) |
| Request review round       | round ≥ 1, not finished         | `escalate` + `resume --to review`                   |
| Request rework             | not finished                    | `escalate` + `resume --to build`                    |
| Accept verification policy | worktree `factory.json` differs | snapshot it as the job's policy (`jobs.policy`)     |
| Cancel job                 | not finished                    | `cancel`                                            |

A job whose session holds a live lease (and is not waiting in `needs-human`) is refused unless the
user confirms a forced takeover, which rotates the token. Every action records a reason in the
events and answers with the fact that no session is running the job plus the exact
`orch factory resume` command; the dashboard never pretends to wake a Claude session.

**Security.** The server binds `127.0.0.1` only, checks the `Host` header against its own
loopback origins (DNS rebinding), rejects cross-site `Sec-Fetch-Site`, and for state-changing
requests requires a same-origin `Origin`, `Content-Type: application/json`, and a per-process
CSRF token obtained from `/api/session` (which a foreign origin cannot read). Bodies are limited to
64 KB and validated field by field; unknown fields are rejected. Static files come only from
`web/dist`; artifact text is served only for files registered in the database (no arbitrary path
reads); job rows never include the owner token; there is no shell-execution endpoint. Responses
carry a CSP, `nosniff`, and `no-store`.

**Development.** `npm run web:dev` starts Vite with hot reload on `127.0.0.1:5173`, proxying
`/api` to a running `orch ui`. `npm run build` compiles both the CLI and `web/dist`.
`npm run test:e2e` runs the Playwright suite against a seeded scratch database (first time:
`npx playwright install chromium`).

## Using the factory

One-time setup on a machine:

```sh
git clone <this repo> && cd agent-orchestrator
npm install && npm link       # `orch` on PATH
orch install                  # link skills/ and agents/ into ~/.claude (see Global Claude skills)
gh auth login                 # only needed for the draft PR at the end
```

### Preparing a repository

The factory runs only the verification checks a repository has committed in `factory.json` (see
[Verification evidence](#verification-evidence)). A repository that has never used the factory is
onboarded once:

```sh
cd ~/code/my-app                                  # 1. an existing Git repository
orch init --from-package-json                     # 2. factory.json from package.json scripts (or --command)
cat factory.json                                  # 3. review: executables on PATH, argument arrays, no shell
git add factory.json && git commit -m "Add factory verification policy" && git push   # 4. commit (and push)
orch init --check                                 # 5. READY, or what is still missing
/factory Add a feature to export reports as CSV   # 6. first job
```

For a TypeScript/npm project whose `package.json` defines `check` (typecheck + lint + test) and
`build`, step 2 writes:

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

`--from-package-json` proposes `npm run <script>` for `check` (or, without one, `test`, `lint`,
`typecheck`) and `build`; it never guesses from a language or lockfile alone, so a repository
without those scripts needs `--command "<id>=<executable> [args...]"` for each check
(`orch init --command "test=cargo test" --command "lint=cargo clippy"`). Running `orch init` with
neither flag prints the suggestions and writes nothing. An existing `factory.json` is never
overwritten without `--force`; the file is written atomically and nothing is committed.

The policy must be committed before the first job because `orch verify` reads `factory.json` from
the merge base of the job branch and its base branch, never from the job's own commits: a builder
that edits the file changes nothing until a human accepts the change. `orch init --check`
(also summarized by `orch doctor`) reports the state the factory would see: `no-git-repository`,
`missing`, `invalid`, `ignored` (by `.gitignore`), `uncommitted`, `no-base-branch` (detached
HEAD), `unpushed` (committed locally but `origin/<branch>`, as last fetched, has a different
policy), `unconfigured` (no commands), `missing-tools` (an executable not on `PATH`), or `ready`.
It resolves the base the same way a job does (`origin/<branch>` when that ref exists, else the
local branch; a repository without an origin needs only the commit) and reads the committed file
with the same code `orch verify` uses. It reads files and Git only; it never runs a check. A
repository with no commits yet is reported `uncommitted`: there is no trusted revision until the
policy is committed.

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

| Stage     | Agent(s)                      | Produces                                                           | `orch` checks before advancing                                                                                                                                                         |
| --------- | ----------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`    | `factory-spec-writer` (Opus)  | `spec.md`                                                          | Goal, Scope, Acceptance criteria present                                                                                                                                               |
| `build`   | `factory-builder` (Opus)      | commits on the job branch + `orch verify` run + `build.md`         | Summary, Validation present; worktree clean; HEAD unchanged since `build.md`; valid verification run for HEAD; round > 1 needs `--replace`                                             |
| `review`  | reviewers below, concurrently | `round-N/review-<r>.md` each + `consolidated.md`                   | every verdict matches its `VERDICT:` line and was recorded against the same clean HEAD, still current; `BLOCKING: 0` to advance; `check-readonly`                                      |
| `approve` | `factory-approver` (Opus)     | `decision.md`                                                      | `DECISION: APPROVE` against the current HEAD; no blocking findings left in the last round; valid verification run; no unauthorized policy change; `ESCALATE` forces `escalate`         |
| `pr`      | the coordinator + `orch gh`   | integrated base, verified commit, pushed branch, draft PR, `pr.md` | approval recorded; only clean base-integration merges since it; policy not drifted; valid `orch verify` run for the pushed HEAD; branch pushed and current; repo identity; PR recorded |

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

`needs-human` jobs stay blocked until a person decides; `resume --to <stage>` sends them back. A
jump cannot skip evidence: `pr` still needs a registered `DECISION: APPROVE`, and `approve` still
refuses while the last round counts blocking findings.

**Evidence is pinned to commits.** `build.md`, every review verdict, and `decision.md` are accepted
only from a clean worktree and are recorded with its HEAD (`artifacts.head`, `reviews.head`). A
stage completes only while HEAD is still that commit, all verdicts of a round name the same commit,
and the files on disk still hash to what was registered; otherwise the evidence is stale and must be
produced again. `orch factory check-readonly` additionally compares the plan's worktree
fingerprint (HEAD plus dirty files) after reviewers ran. Workflow artifacts can be registered or
replaced only in their own stage and round, so an approval cannot be rewritten after the fact.
`plan.checkoutDirty` lists uncommitted files in the initiating checkout; the factory never writes
there, so a list that grows during a stage means a subagent used the wrong directory.

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

| Table                 | Purpose                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `jobs`                | One row per job: identity, repo, branch, worktree, stage, status, round, owner lease, PR, CI, rev. |
| `events`              | Append-only activity log (`type`, JSON `payload`, `actor`, timestamp) per job                      |
| `artifacts`           | Registered artifact files: relative path, stage, round, size, sha256, parsed marker, HEAD          |
| `reviews`             | One row per reviewer per round: verdict (`pass`/`changes`/pending), artifact, summary, HEAD        |
| `verification_runs`   | One `orch verify` invocation: commit, tree, policy fingerprint and source, status                  |
| `verification_checks` | One row per check of a run: command, cwd, status, exit code, duration, log path and hash           |
| `integrations`        | One base-integration attempt: inputs recorded before Git runs, outcome after                       |

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
| `rework`   | stage `pr` (base integration needs the builder)           | stage `build`, status `pending`; re-review follows      |
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
`integration.started`, `integration.completed`, `verification.started`,
`verification.completed`, `policy.authorized`, `job.reworked`, `branch.pushed`, `pr.recorded`,
`ci.observed`) in the same transaction.
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
  The checkout used is the job's recorded `repoPath` (or `--repo <other clone>`). The job's own
  repository is recognised by its Git common directory (so the checkout and every linked worktree
  qualify, whatever happened to `origin` since); another clone qualifies only when its `origin` is
  the job's recorded identity.
- `adopt` validates that the directory is the top level of a worktree of the same repository, on a
  branch, and not the primary checkout. Two jobs can never share a worktree or a branch; the
  database refuses it.
- `remove` and `integrate` refuse to run over uncommitted changes; `integrate` aborts cleanly on a
  conflict and reports the files, leaving the worktree exactly as it was. The branch and its
  commits are always preserved; `orch` never deletes uncommitted or unpushed work.

**Base integration** records an `integrations` row before Git runs (job HEAD, base ref and SHA,
merge base, the approval commit, the valid verification run) and completes it afterwards (result
HEAD, conflicts, files changed by taking the base, and `material`: files whose merge result matches
neither parent, from `git diff-tree --cc`). Outcomes: `up-to-date` (no commit), `merged`, `conflict`
(merge aborted), `interrupted`. In the `pr` stage a conflict, or a merge with material edits, moves
the job back to `build` (`rework`): the builder merges and resolves, and the result is verified,
reviewed, and approved again. A clean merge only needs a fresh `orch verify` on the new commit.
On resume, a row left `started` is reconciled from Git: a half-done merge (`MERGE_HEAD`) is
aborted, a merge that completed but was never recorded is recorded, anything else is marked
interrupted; the merge is never blindly retried. Delivery (`gh push`, `gh pr create`) then requires
that every commit since the approval is a merge with no material edits, that the policy has not
drifted without authorization, and that the latest verification run is valid for the pushed HEAD.

- `create`, `adopt`, `remove`, and `integrate` require the job's owner token; `show` is read-only.

**Ownership is advisory at the filesystem level.** The CLI enforces that only the owner records
changes about a job, but any process with filesystem access (including a subagent pointed at the
wrong directory) can write into another job's worktree, the initiating checkout, the artifact
directory, or the SQLite file itself. What the CLI can do is refuse to count such writes as
progress: evidence is accepted only from a clean worktree at a recorded HEAD, re-hashed at every
gate, and the plan reports dirty files in both trees. Skills pass the worktree path explicitly to
every subagent. A worktree on the base branch, or inside the initiating checkout, cannot be adopted.

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

Before pushing or creating a PR, `orch` checks that the job is in the `pr` stage, that
`decision.md` is a registered `APPROVE` tied to a commit, that every commit since that commit is a
base-integration merge (`rev-list --no-merges <approved>..HEAD ^<base>` is empty), that the job
branch is not the base branch, that GitHub's repository for the checkout matches the job's
identity, that the base branch exists on `origin`, and (for the PR) that `origin/<branch>` equals
the worktree HEAD. An open (or merged) PR for the
branch with the same base is reused instead of creating a duplicate. The PR is recorded on the job
(`prUrl`, `prState`) together with the CI rollup (`ciStatus`: `none`, `pending`, `passing`,
`failing`). `orch` never merges, force-pushes, or marks a PR ready; a recorded draft PR is not a
passing CI run.

Tests never call GitHub: setting `ORCH_GH_SHIM=<file.cjs>` makes `orch` run `node <file> <args>`
instead of `gh`, and the suite uses a stateful shim plus a local bare repository as `origin`.

## Verification evidence

`orch verify <id>` is the only source of automated validation evidence. It runs the repository's
verification policy inside the job's clean worktree and records what happened; `build`, `approve`,
and `pr` cannot complete, and nothing is pushed, without a run that is still valid for the exact
HEAD.

```sh
orch verify <id> --token <t>     # run the policy; exit 1 on a failed required check or no policy
orch verify show <id>            # latest run and whether it is still valid for HEAD (read-only)
```

**Policy.** A `factory.json` at the repository root (committed, like any file) declares the checks:

```json
{
  "verification": {
    "commands": [
      { "id": "check", "command": "npm", "args": ["run", "check"], "required": true },
      {
        "id": "e2e",
        "command": "npm",
        "args": ["run", "test:e2e"],
        "cwd": "web",
        "required": false,
        "timeoutMs": 900000
      }
    ]
  }
}
```

`command` is an executable name resolved on `PATH` (no paths, no shell strings); `args` is an
array; `cwd` is relative to the worktree and must resolve inside it (links out are refused);
`required` defaults to true; `timeoutMs` defaults to ten minutes. Checks run in order and stop at
the first failed required one. Nothing from job titles, descriptions, issues, or the dashboard is
ever executed.

**Trusted baseline.** The effective policy is the `factory.json` at the merge base of the job
branch and its base branch: code the job did not write. A job editing its own `factory.json`
changes nothing by itself; `orch verify` keeps running the baseline, the plan reports
`policy.authorization: required`, `approve` and delivery are refused, and a human can accept the
proposed file from the dashboard (**Accept verification policy**), which snapshots it on the job
(`jobs.policy`) and makes every earlier run stale. A repository with no policy at the baseline
gets `configuration-required`: the gate stays closed until a policy exists on the base branch or a
proposed one is accepted. Nothing is invented.

**What a run records** (`verification_runs`, `verification_checks`): job, run id, commit and tree,
dirty files (always none, since a dirty worktree is refused), the policy fingerprint and where it
came from, start and end times, and per check the executable, argument array, working directory,
required flag, timeout, status (`passed`, `failed`, `timed-out`, `error`, or `pending` when an
earlier required check already failed), exit code or signal, duration, and the log file under
`<artifacts>/verification/<run>/<check>.log` with its SHA-256 (long output keeps its head and tail
and is marked truncated). All expected checks are rowed before anything runs, so an interrupted run
is visibly incomplete; starting a new run marks any still-`running` one `interrupted`.

**Validity.** A run is evidence only while HEAD and its tree are unchanged, the worktree is clean,
the policy fingerprint matches the effective policy, every currently required check passed in
that run, and the run completed. Anything else is reported as the reason it is stale.

**Sensitive changes.** The plan classifies the job's diff (`plan.sensitive`): application tests
(added, modified, deleted), test or lint configuration, CI workflows, dependency manifests, and
`factory.json`, for JavaScript, Python, Go, Rust, and Ruby layouts; the diff of changed test files
is scanned for skipped, focused, or commented-out tests and for removed test definitions, and the
policy is diffed against the baseline (added, removed, modified, weakened checks). Newly added
tests alone need no special attention; everything else sets `needsReview`, and `orch` refuses a
`round-N/consolidated.md` or `pr.md` that lacks a `Sensitive changes` section naming each path.
Reviewers are told to read those diffs. Classification is a label, not a block: disabling a test is
caught because a reviewer must address it, not because the CLI understands the test.

## Ownership and resumability

Several VS Code sessions may run at once, so each job has at most one owner.

- `orch job claim <id> --session <name>` atomically takes the job and returns a **token**. The lease
  lasts `--lease` minutes (default 30). Pass the token as `--token` or `ORCH_TOKEN` on every
  mutation; `ORCH_SESSION` can stand in for `--session`.
- **Renewal is explicit.** There is no daemon. Every successful mutation by the token holder extends
  the lease by the claimed length. `claim` or `resume` again, even from the same session name,
  issues a new token and kills the old one: two processes resuming under one name cannot both keep
  driving the job. A session that goes quiet simply lets the lease lapse.
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
orch doctor                            # also reports stale or missing installed skills/agents
orch init  [--repo <path>] --command "<id>=<exe> [args...]"... | --from-package-json [--force]
orch init  [--repo <path>] --check     # policy present, valid, committed, pushed, tools on PATH; exit 1 unless ready
orch install [--dry-run] [--source <dir>] [--claude-dir <dir>]

orch job create    --title <t> [--description <d>] [--issue <ref>] [--repo <path>] [--base <branch>]
                   [--max-rounds <n>]
orch job list      [--repo <path|identity>] [--status <s>] [--stage <s>]
orch job show      <id>
orch job events    <id> [--limit <n>]
orch job claim     <id> --session <name> [--lease <minutes>] [--force]
orch job release   <id> --token <t>
orch job resume    <id> --session <name> [--to <stage>] [--force]
orch job transition <id> start|complete|fail|escalate|resume|rework|cancel --token <t>
                   [--to <stage>] [--reason <r>] [--revision <n>]
orch job artifact add <id> <relative-path> --token <t> [--replace] [--revision <n>]
orch job review record <id> --reviewer <name> [--verdict pass|changes] [--artifact <path>]
                   [--summary <s>] --token <t>
orch job pr        <id> --url <url> --state draft|ready|merged --token <t>
orch job repo      <id> [--repo <path>] --token <t>   # refresh the identity now (mutations do it anyway)

orch worktree create|show|adopt|remove|integrate <id> [--path <dir>] [--repo <clone>] --token <t>
orch gh repo | issue <ref> | push <id> | pr create <id> --body-file <md> | pr status <id>
orch verify <id> --token <t>           # run the repository's verification policy; exit 1 on failure
orch verify show <id>                  # latest run and validity for HEAD

orch factory start  --title <t> | --issue <ref> [--description <d>] [--repo <path>] [--base <b>]
                    [--max-rounds <n>] --session <name> [--ui|--no-ui]
orch factory next|status <id> [--ui|--no-ui]
orch factory resume <id> --session <name> [--to <stage>] [--force]
orch factory check-readonly <id> --fingerprint <f>
orch factory config

orch ui [--port <n>] [--open]          # the only long-running command; loopback only
```

`job create` detects the repository from the current directory (or `--repo`), records its identity
(normalized `origin` URL, e.g. `github.com/org/repo`, or the directory name) and current branch,
and does not need GitHub: `--issue` is an opaque reference. The identity is the remote's: it groups
jobs and is checked against GitHub at delivery. The job's binding to its local repository is the
checkout's Git common directory, so adding or re-pointing `origin` later refreshes the identity on
the next mutation (recorded as `repo.repointed`) instead of orphaning the job; `job list --repo
<path>` finds a repository's jobs from its checkout or any linked worktree either way.

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

## Enforced versus cooperative (Phase 5B)

Enforced in code: every gate above; `orch verify` runs only the baseline or a human-accepted
policy, only in the job worktree, only on a clean commit, with argument arrays; evidence validity
is recomputed from HEAD, tree, policy fingerprint, and the run's rows at every gate; delivery is
bound to the pushed commit; conflict resolutions and edits inside merge commits are detected and
routed back through review; integration attempts are recorded before Git runs and reconciled on
resume; `consolidated.md` and `pr.md` must name every sensitive path.

Cooperative (prose only): reviewers actually reading the verification logs and the sensitive
diffs; builders not disabling tests in ways the scan does not recognise; the policy on the base
branch being meaningful (an empty or weak `factory.json` merged by humans is trusted as policy);
subagents staying inside the worktree; checks not being influenced by ignored files
(`node_modules`, build caches) that `git status` cannot see; child processes of a timed-out check
being cleaned up on Windows (the direct child is killed; grandchildren may linger).

## Limits

Implemented: the durable core, worktrees, validated artifacts pinned to commits, executed
verification evidence, sensitive-change labelling, recorded base integration, GitHub via `gh`,
`orch factory`, the `/factory` skill, ten agents, Windows-safe install, and the dashboard (`orch
ui`, the loopback JSON API with Origin/CSRF/Host guards, the job board and job detail, human
controls through the shared domain layer, light and dark modes, API tests, component tests (jsdom),
and Playwright browser checks over seeded fixtures).

Not implemented: Claude session spawning or restoration (the dashboard records decisions; a session
must resume), token accounting, any daemon or scheduler (the dashboard is a plain server you start
and stop; nothing runs between commands), automatic crash recovery (a lapsed lease is only noticed
when someone runs `factory next`, `resume`, or looks at the board), rebase-based integration (only
merge commits), authentication for the dashboard (it is loopback-only and single-user by design), a
workflow definition language, and plugin distribution. Ordinary CI never calls a model: the skill
and agents are exercised by their contracts (frontmatter, templates, commands), and a live run
requires a Claude Code session. The `events` table is an audit log, not an event-sourcing store.
See `docs/decisions.md` for the reasoning behind what exists.
