# Developing orch

Stack, layout, build, validation, database migrations, install mechanics, Windows notes, and the
full CLI reference. `CLAUDE.md` has the rules for changing the code.

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
output (`web/dist`) ships prebuilt. See decision 10 under `docs/decisions/` for why the rc is pinned.

## Layout

```
src/
  cli/           main.ts (arg parsing, dispatch), args.ts (option helpers), output.ts, and one
                 file per command: doctor, init, install, job, worktree, gh, verify, factory,
                 checkout, ui, recover
  core/          workflow.ts, artifact-rules.ts, roles.ts, ownership.ts, verification.ts, ci.ts,
                 sensitive.ts, session.ts, recovery.ts, errors.ts, paths.ts, exec.ts
  storage/       schema.ts, client.ts, jobs.ts, events.ts, artifacts.ts, verification.ts,
                 checkouts.ts (only SQLite importer)
  git/           run.ts (git with arg arrays), repo.ts (queries), worktree.ts (worktree ops)
  integrations/  claude.ts (skill/agent linking), github.ts (gh CLI wrapper)
  ops/           factory.ts (the plan), dispatch.ts, gates.ts (Git-aware gates), verify.ts (runs
                 the policy), worktree.ts, github.ts, repo.ts (job <-> repository), checkout.ts,
                 init.ts, usage.ts, actions.ts (dashboard actions), tree.ts, recover.ts
                 (recovery worker passes, loop, PID file), verify-lock.ts
  server/        http.ts (loopback server, guards, static), api.ts (read models), status.ts
                 (derived liveness, blockers, CI view), types.ts (shared with web/)
web/             Vite + React + MUI dashboard: index.html, src/*.tsx, vite.config.ts -> web/dist
drizzle/         generated SQL migrations + snapshots (committed, shipped)
drizzle.config.ts
tests/           Vitest suites, mirror src/; helpers.ts (fixtures), drive.ts (stage driver),
                 fixtures/dashboard.ts (seeded dashboard state)
e2e/             Playwright browser checks for the dashboard (playwright.config.ts)
scripts/         seed-dashboard.ts (demo data into a scratch ORCH_HOME)
docs/                workflow.md, dashboard.md, development.md (this file), session-launch.md,
                 phase3-validation.md, decisions/ (one file per decision; decisions.md explains)
.github/workflows/ci.yml
```

```
skills/factory/  SKILL.md (the coordinator), reference.md (agent inputs, artifact templates)
agents/          factory-spec-writer, factory-spec-challenger, factory-builder, factory-reviewer-{security,correctness,
                 code-quality,ui-design,ux,accessibility,web-platform}, factory-approver
```

## Install and develop

```sh
git clone <this repo> && cd agent-orchestrator
npm install
npm run build          # dist/ and web/dist; the linked `orch` runs dist/
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

Every Vitest file runs behind `tests/setup.ts`: `ORCH_HOME` is pointed at a scratch directory for
the run (whatever the shell had, so a developer's or another campaign's database is never opened),
and every directory the file created through `tempDir()` is removed when the file finishes, after
failures too. Test repositories, stores, shims, and worktrees are all `mkdtemp` directories;
nothing in the suite uses a fixed path under the temp directory. Two sessions must still not run
the suite in the _same_ checkout (decision #45): the CLI tests load `src/` from it.

CI runs every check on Ubuntu (typecheck, lint, format, migrations, the Vitest suite with coverage,
the build, the Playwright dashboard checks, and a database initialized from `dist/` outside the
repository) and fails if `src/storage/schema.ts` has changes without a committed migration. The
whole Vitest suite runs on Windows too, split across four runners grouped by measured duration,
plus the built CLI smoke checks (decision 50).

## Validation

```sh
npm run check          # typecheck + lint + format:check + test
npm run test:coverage  # coverage report (text + lcov in coverage/)
npm run db:check       # validate committed migrations
npm run format         # apply Prettier
npm run build
```

Every Vitest file runs behind `tests/setup.ts`: `ORCH_HOME` is pointed at a scratch directory for
the run (whatever the shell had, so a developer's or another campaign's database is never opened),
and every directory the file created through `tempDir()` is removed when the file finishes, after
failures too. Test repositories, stores, shims, and worktrees are all `mkdtemp` directories;
nothing in the suite uses a fixed path under the temp directory. Two sessions must still not run
the suite in the _same_ checkout (decision #45): the CLI tests load `src/` from it.

CI runs every check on Ubuntu (typecheck, lint, format, migrations, the Vitest suite with coverage,
the build, the Playwright dashboard checks, and a database initialized from `dist/` outside the
repository) and fails if `src/storage/schema.ts` has changes without a committed migration. The
whole Vitest suite runs on Windows too, split across four runners grouped by measured duration,
plus the built CLI smoke checks (decision 50).

## Database and migrations

`src/storage/schema.ts` is the schema, in TypeScript. `npm run db:generate` turns changes into a
timestamped SQL migration under `drizzle/`, which is committed and included in the package `files`.
Whenever the CLI opens the database it enables WAL mode, foreign keys, and a 5 s busy timeout, then
applies any migrations not yet recorded in `__drizzle_migrations`. A fresh machine gets a complete
database on first use; an existing database is upgraded in place. Nothing ever deletes, resets, or
recreates a database, and `drizzle-kit push` is never used.

Tables:

| Table                 | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `jobs`                | One row per job: identity, repo, branch, worktree, stage, status, round, owner lease, PR, CI (rollup, head, repairs), rev. |
| `events`              | Append-only activity log (`type`, JSON `payload`, `actor`, timestamp) per job                                              |
| `artifacts`           | Registered artifact files: relative path, stage, round, size, sha256, parsed marker, HEAD                                  |
| `reviews`             | One row per reviewer per round: verdict (`pass`/`changes`/pending), artifact, summary, HEAD                                |
| `verification_runs`   | One `orch verify` invocation: commit, tree, policy fingerprint and source, status                                          |
| `verification_checks` | One row per check of a run: command, cwd, status, exit code, duration, log path and hash                                   |
| `integrations`        | One base-integration attempt: inputs recorded before Git runs, outcome after                                               |

`jobs.worktreePath` and (`repo`, `branch`) are unique, so a managed worktree or branch belongs to
at most one job.

All writes happen in `BEGIN IMMEDIATE` transactions, so concurrent `orch` processes queue on
SQLite's write lock instead of corrupting state. Every job mutation increments `jobs.revision`.

## CLI reference

Global flags: `--json` (machine output; errors become `{"error":{...}}` on stderr), `--help`,
`--version`. Exit codes: 0 success; 1 failed check, validation error, or illegal transition;
2 usage error; 3 not found; 4 ownership (another owner, bad or stale token, stale revision).

```
orch doctor                            # also reports stale or missing installed skills/agents
orch init  [--repo <path>] --command "<id>=<exe> [args...]"... | --from-package-json [--force]
orch init  [--repo <path>] --check     # policy present, valid, committed, pushed, tools on PATH; exit 1 unless ready
orch install [--dry-run] [--source <dir>] [--claude-dir <dir>]

orch job create    --title <t> --description <d> [--issue <ref>] [--repo <path>] [--base <branch>]
                   [--max-rounds <n>]   # --description required and non-blank; --issue only recorded
orch job list      [--repo <path|identity>] [--status <s>] [--stage <s>]
orch job show      <id>
orch job events    <id> [--limit <n>]
orch job usage     <id>                 # measured durations per stage, reviewer, verification, CI; no token counts
orch job claim     <id> --session <name> [--lease <minutes>] [--force]
orch job release   <id> --token <t>
orch job resume    <id> --session <name> [--to <stage>] [--force]
orch job transition <id> start|complete|fail|escalate|resume|rework|cancel --token <t>
                   [--to <stage>] [--reason <r>] [--revision <n>]
orch job artifact add <id> <relative-path> --token <t> [--replace] [--revision <n>]
orch job review record <id> --reviewer <name> [--verdict pass|changes] [--summary <s>] --token <t>
orch job repo      <id> [--repo <path>] --token <t>   # refresh the identity now (mutations do it anyway)
orch job supersede <id> --by <new-id> --session <name> [--force]   # record that <new-id> replaced <id>

orch worktree create|show|adopt|remove|integrate <id> [--path <dir>] [--repo <clone>] --token <t>
orch gh repo | issue <ref> | push <id> | pr create <id> --body-file <md> | pr status <id>
orch gh ci <id> --token <t>            # reconcile CI for the PR head (ci stage only)
orch verify <id> --token <t>           # run the repository's verification policy; exit 1 on failure
orch verify show <id>                  # latest run and validity for HEAD

orch factory start  --title <t> --description <d> | --issue <ref> [--title <t>] [--description <d>]
                    [--repo <path>] [--base <b>] [--max-rounds <n>] --session <name> [--ui|--no-ui]
orch factory dispatch --title <t> --description <d> | --issue <ref> [--title <t>] [--description <d>]
                    [--repo <path>] [--base <b>]
                    [--max-rounds <n>] --session <name>   # job for another repo; an independent session runs it
orch factory list   [--repo <path|identity>]              # one row per job: stage, status, action, PR, title
orch factory next|status <id> [--ui|--no-ui]          # where, what blocks, next step, numbered commands; --json for the full plan
orch factory resume <id> --session <name> [--to <stage>] [--force] [--adopt <worktree>]
orch factory cancel <id> --reason <r> --session <name> [--force]   # exit 4 if another session holds a live lease
orch factory check-readonly <id> --fingerprint <f>
orch factory config
orch job session attach <id> --provider vscode-agents|claude-code --ref <link|uuid> [--cwd <dir>] [--token <t>]

orch ui [--port <n>] [--open]          # long-running, optional; loopback only
orch recover start|stop|status [--json] # opt-in recovery worker (detached, PID file in the data dir)
orch recover run [--once]              # the worker in the foreground, or one pass
```

`job create` detects the repository from the current directory (or `--repo`), records its identity
(normalized `origin` URL, e.g. `github.com/org/repo`, or the directory name) and current branch,
and does not need GitHub: `--issue` is an opaque reference. The identity is the remote's: it groups
jobs and is checked against GitHub at delivery. The job's binding to its local repository is the
checkout's Git common directory, so adding or re-pointing `origin` later refreshes the identity on
the next mutation (recorded as `repo.repointed`) instead of orphaning the job, provided the job's
worktree still belongs to that checkout; a checkout replaced by another repository is refused, and
a job without a worktree needs `job repo <id>` to confirm the new identity. `job list --repo
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
orch job create --title "Add rate limiting" --description "Limit /api to 100 req/min per key" --json   # -> jobId
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
- A verification check that exceeds its `timeoutMs` is killed, and on Windows its descendants are
  killed too: `spawnSync` only terminates the direct child, which for `npm test` is `cmd.exe`, so
  `src/core/exec.ts` then reads the process table (PowerShell `Get-CimInstance Win32_Process`),
  walks the children of the dead root (Windows keeps an orphan's parent id), and terminates every
  process created since the check started, by pid. The check log records what was killed and
  anything that could not be; a tree that was not fully stopped is written into the check's
  `error` column. No process is ever killed by name.
