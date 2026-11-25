# CLAUDE.md

Guidance for Claude Code sessions working on this repository. Read `README.md` for what the project
is; this file is about how to change it.

## Commands

```sh
npm run check            # typecheck (CLI + web) + lint + format:check + test; run before finishing
npm run dev -- <args>    # run the CLI from source (Node strips types natively)
npm run build            # tsc -> dist/ and vite -> web/dist (the linked `orch` binary runs dist/)
npm run db:generate      # after editing src/storage/schema.ts: write a migration under drizzle/
npm run db:check         # validate committed migrations
npm run test:coverage
npm run test:e2e         # Playwright against a seeded `orch ui` (needs `npx playwright install chromium`)
npm run web:dev          # Vite dev server for web/, proxying /api to a running `orch ui`
```

## Architecture boundaries

- `src/cli/` parses arguments and prints. No business logic; handlers call into `storage/` and
  `ops/` and return plain data that `output.ts` renders as text or JSON. Option parsing helpers
  (`oneOf`, `int`, `need`, `authFrom`) live in `args.ts`; every usage mistake is a `UsageError`.
- `src/core/` holds domain rules: `workflow.ts` (stages, statuses, the pure `transition`
  function), `artifact-rules.ts` (required sections and marker lines per artifact path),
  `ownership.ts` (lease decisions), `roles.ts` (agents and models), `verification.ts` (policy
  parsing and run validity), `sensitive.ts` (diff classification), `errors.ts` (every error
  class, each carrying its exit code), `paths.ts` (filesystem conventions), `exec.ts` (safe
  subprocess helpers). No I/O beyond `paths.ts` and `exec.ts`.
- `src/storage/` is the only module that imports `node:sqlite` or the Drizzle driver. Schema in
  `schema.ts`; every job mutation goes through `jobs.ts`, which wraps a pure `core/` decision in
  one immediate transaction. Nothing else writes to the database.
- `src/git/` wraps Git (`run.ts` argument-array runner, `repo.ts` queries, `worktree.ts` worktree
  operations) and knows nothing about jobs. `src/integrations/` wraps Claude Code (the installer)
  and the `gh` CLI (`github.ts`, honouring `ORCH_GH_SHIM` for tests).
- `src/ops/` sequences the above for a job: `authorize()` the owner, act on Git or GitHub, then
  record through `storage/jobs.ts`. It is the only layer allowed to import both `git/` or
  `integrations/` and `storage/`. Nothing in `ops/` deletes uncommitted work or force-pushes.
  `ops/factory.ts` builds the plan the `/factory` skill follows; `core/roles.ts` is the only place
  that names agents and models. `ops/repo.ts` is the only place that decides whether a path is a
  job's repository: by Git common directory for the job's own checkout and worktrees, by remote
  identity for another clone. Never compare `describeRepo().identity` to `job.repo` elsewhere.
- Tickets are the global queue (`docs/tickets.md`): rules in `core/tickets.ts` (values, status
  machine, cycle check, order, block reasons), every ticket mutation in `storage/tickets.ts`, and
  `ops/tickets.ts` as the one entry point for both `cli/ticket.ts` and the `/api/tickets` routes,
  so validation is never repeated in a handler. SQLite is the only source of truth: no Markdown
  export, no dual write. A job is linked to a ticket only through `createJob`'s `ticketId` (the
  claim runs in the job's insert transaction; `jobs_active_ticket_idx` allows one unfinished job
  per ticket); nothing completes a ticket except `orch ticket done` and a verified merge recorded
  by `recordMerge`. The skill `.claude/skills/log-todo` calls `orch` only; `orch install`
  links it globally along with `skills/factory`. `orch do <ticket>` is the one autonomous way to
  run a ticket; the manual path is `/factory <job>` in a session, then `orch do <ticket>` or
  `orch job merge` (decision 2026-11-23-manual-and-autonomous-ticket-runs).
- Merging is one operation: `mergeJob` in `src/ops/merge.ts`, the only caller of `mergePr`, behind
  both `orch job merge` and the dashboard's Merge (decision 2026-11-20-orch-job-merge). Its rule
  is the pure `mergeDecision` in `core/workflow.ts`, fed GitHub's fresh answer; add a merge
  condition there, never in a caller or a skill. A merge counts only once a second read of the PR
  says MERGED, and `recordMerge` in `storage/jobs.ts` writes the evidence and the ticket's
  completion in one transaction. Callers other than the dashboard need the repository in the
  user's `mergeRepos` (`orch factory config merge`); never read that from a repository file. No
  merge queue, lock, or polling; a completed job stays completed. The one exception is the
  factory controller's bounded backoff on a transient GitHub failure (`transientGitHubError` in
  `core/workflow.ts`), inside its foreground command (decision
  [2026-11-25-bounded-github-retry](docs/decisions/2026-11-25-bounded-github-retry.md)).
- `skills/factory/` and `agents/` are prose for Claude, linked into `~/.claude` by `orch install`.
  They must only call `orch` commands; any rule that matters is enforced in TypeScript first and
  described in prose second. `tests/skill-contract.test.ts` keeps roles, agent frontmatter, and the
  reference templates consistent with the code.
- Workflow state transitions are enforced in TypeScript, never only in skill prose. A stage is
  complete only when its required artifact has been validated (location, type, structure, marker)
  and registered; replacing registered content requires `--replace`.
- Evidence is Git-bound and executed, never claimed. `src/ops/gates.ts` is the CLI's only path into
  `artifact add`, `review record`, and `transition complete`; `src/ops/verify.ts` is the only
  thing that runs a repository's checks (`factory.json` at the merge base, or the policy a human
  accepted, via `spawnCommand` in `core/exec.ts`, in the worktree, on a clean commit). Gates
  recompute validity from `core/verification.ts`; never add a flag that skips one. Sensitive-path
  rules live in `core/sensitive.ts` and only label; they never execute anything.
- Base integration goes through `integrateBase` in `src/ops/worktree.ts`, which records an
  `integrations` row before Git runs and reconciles a `started` row on the next call. Edits inside
  a merge commit (`git diff-tree --cc`) are new code: `rework`, never a push.
- Mutable state goes under `runtimePaths()` from `src/core/paths.ts`: the database at
  `databasePath()`, artifacts at `jobArtifactDir(id)`, worktrees at `jobWorktreeDir(id, repo)`.
  Never write into the install root, a skill directory, or a project repository.
- The CLI must work from any directory. Resolve the project via `findProjectRoot(cwd)`, this
  installation via `installRoot()`, and migrations via `migrationsDir()`.
- `src/server/` is the dashboard: `http.ts` (node:http on 127.0.0.1 only, Host/Origin/CSRF
  guards, static files from `web/dist`), `api.ts` (read models; `safeJob` strips `ownerToken`),
  `status.ts` (liveness, blockers, CI view derived from rows), `types.ts` (shared with `web/src`). Writes go through `ops/actions.ts`, never straight to
  storage. The Tickets section (`web/src/Tickets.tsx`, `TicketDetail.tsx`) only shows what
  `/api/tickets` computed and posts ticket actions; `web/src/ticketState.ts` is presentation, never
  a readiness or lifecycle rule. `GET /api/runner` is `runnerStatus` and nothing else: no route
  starts, stops, or resumes the controller. `web/` is the React + MUI client with its own `tsconfig.json`; it imports only
  `src/server/types.ts` and `src/ops/actions.ts` types from `src/`.
- The CLI is one-shot: open the store, do one operation, print, exit. No daemons, timers, or
  background work. There are three exceptions, all opt-in and never required for jobs to run:
  `orch ui`, which serves the dashboard until interrupted; the recovery worker
  (`orch recover run`, or `orch recover start` to detach it), which repeats one-shot passes that
  continue only `ci`-stage jobs no live session owns and never launches or messages a Claude
  session (decision 2026-11-16-opt-in-recovery-worker); and the factory controller
  (`orch start`, `orch do`, `orch resume`), a foreground process that exists only while its
  command runs.
- Only the factory controller starts a Claude process, and only through `launchClaude` in
  `src/integrations/claude-session.ts`: one headless `/factory <job>` child at a time, for the
  ticket it is working on (decision 2026-11-21-foreground-factory-runner). `src/ops/run.ts`
  sequences existing operations (`listTickets`, `dispatchJob`, `resumeFactoryJob`, `reconcileCi`,
  `mergeJob`) and re-reads the job row at every step; it implements no stage, skips no gate, and
  never calls `gh` or `orch ticket done` itself. Its own state is the single-writer files of
  `src/ops/runner-state.ts`, never a table and never a copy of job or ticket state. What it did to
  a job it records on that job as `runner.session` and `runner.stopped` events (decision
  2026-11-21-runner-evidence-on-the-job), from the one exit of `runTicket`, only on a job it holds
  or nobody holds; they are evidence, and nothing may decide from them. Do not detach
  it, start it from the dashboard or another command, message a session, run two tickets at once,
  or signal a PID read from a file.

## Schema changes

Edit `src/storage/schema.ts`, run `npm run db:generate`, review the SQL under `drizzle/`, and commit
both. Never hand-edit generated SQL, never run `drizzle-kit push`, never delete or reset an
existing database. CI fails if the schema and committed migrations disagree.

## Conventions

- TypeScript strict, ESM, `.ts` extensions on relative imports (tsc rewrites them for `dist/`).
- Only erasable TypeScript syntax: no `enum`, no parameter properties, no `namespace` with values.
- Node built-ins first (`node:util` parseArgs, `node:child_process`, `node:path`, `node:fs`).
- Cross-platform always: `path.join`, no hard-coded separators or drive letters, no Unix-only shell
  assumptions. Spawn tools with argument arrays via `execFileSync` or `runTool` in
  `src/core/exec.ts`; never build a shell string from user input.
- Small modules, explicit types, no generalized abstractions before a second real use.
- Exit codes: 0 success, 1 failed check / validation / illegal transition, 2 usage error, 3 not
  found, 4 ownership (another owner, bad token, stale revision). Throw an `OrchError` subclass from
  `src/core/errors.ts`; `main.ts` maps it.

## Dependencies

Runtime: `drizzle-orm` (pinned `1.0.0-rc.5`, the only line with a `node:sqlite` driver). Dev adds
`drizzle-kit` at the same pin. Before adding anything else, confirm a Node built-in or a few lines
of code cannot do it. Do not add a DI container, workflow engine, queue, process supervisor, or CLI
framework. Upgrade Drizzle deliberately, both packages together.

## Tests

- Vitest, files in `tests/` mirroring `src/`, named `*.test.ts`. Shared fixtures in
  `tests/helpers.ts` (`tempStore`, `makeRepo`, `orch`, `orchAsync`).
- Pure rules (`workflow.ts`, `artifact-rules.ts`, `ownership.ts`) are tested with explicit
  inputs. Storage tests use real temporary SQLite files, never mocks. CLI tests spawn
  `node src/cli/main.ts` with `cwd` outside the repo and `ORCH_HOME` set to a temp dir.
- Git tests use real temporary repositories (`makeRepo`, `makeRepoWithOrigin` with a local bare
  `origin`). GitHub tests run a stateful `gh` shim via `ORCH_GH_SHIM`; nothing reaches the network.
  Artifact fixtures come from `fixture(path, marker?)` in `tests/helpers.ts`.
- Tests must never touch the real user data directories or `~/.claude`.
- Verification tests use real subprocesses (`node -e ...` as the configured command) and real
  `factory.json` files committed to temporary repositories; `tests/verify.test.ts`,
  `tests/sensitive.test.ts`, and `tests/integration.test.ts` cover the verification, sensitive-path,
  and base-integration gates.
  `tests/drive.ts` drives a job through its stages the way the CLI does (through `ops/gates.ts`
  and `ops/verify.ts`); reuse it instead of re-implementing stage helpers in a new test file.
- The suite spawns many Git and Node processes and runs its files in parallel; on a loaded
  Windows machine a CLI-heavy file can take minutes. A single failure in `tests/factory.test.ts`
  or `tests/cli.test.ts` that passes alone is load, not a defect; rerun it in isolation first.
  A file's tests run serially, so keep driven-job files short: the ci, audit, factory,
  integration, and verify scenarios are split across files that share a `*-fixture.ts` module
  (its state is per file, since Vitest loads it once per test file). Add a slow scenario to the
  shortest matching file, or a new one, rather than growing a long one.
- One session per checkout. CLI tests load `src/` from the checkout they run in, so a parallel
  session works in its own worktree, never in the primary checkout alongside another; the
  `orch checkout hook` in `.claude/settings.json` refuses an Edit/Write into a checkout another
  live session holds (decisions 45, 60). Read a failing CLI test's stderr before blaming load: a
  `ReferenceError` or `SyntaxError` means a mid-edit tree.
- `/factory` may run against this repository. A job's gates are the installed `orch` (the primary
  checkout's built `dist/`), not the job's branch; the job's own `src/` is exercised only by its
  verification run in its worktree. Rebuild `dist/` only from `main`. Running the full suite on this
  Windows machine takes about ten minutes idle and longer under load; give every run an explicit
  timeout.

## Documentation

Keep `README.md` accurate to what is implemented and short: it answers what, why, install, configure,
start, dispatch, inspect, what is automated, what needs a human, limits. Internals go in `docs/`
(`workflow.md`, `dashboard.md`, `development.md`). Record non-obvious architectural decisions as
one file each under `docs/decisions/` (`YYYY-MM-DD-<slug>.md`, see `docs/decisions.md`) with a
short rationale; never renumber or edit a shared list.
`docs/decisions/2026-11-24-positioning-and-non-goals.md` is the test for new features.
