# CLAUDE.md

Guidance for Claude Code sessions working on this repository. Read `README.md` for what the project
is; this file is about how to change it.

## Commands

```sh
npm run check            # typecheck + lint + format:check + test; run before finishing any task
npm run dev -- <args>    # run the CLI from source (Node strips types natively)
npm run build            # tsc -> dist/ (the linked `orch` binary runs dist/)
npm run db:generate      # after editing src/storage/schema.ts: write a migration under drizzle/
npm run db:check         # validate committed migrations
npm run test:coverage
```

## Architecture boundaries

- `src/cli/` parses arguments and prints. No business logic; handlers call into `storage/` and
  `core/` and return plain data that `output.ts` renders as text or JSON.
- `src/core/` holds domain rules: `workflow.ts` (stages, statuses, the pure `transition`
  function), `artifact-rules.ts` (required sections and marker lines per artifact path),
  `ownership.ts` (lease decisions), `errors.ts` (error classes carrying exit codes), `paths.ts`
  (filesystem conventions), `exec.ts` (safe subprocess helpers). No I/O beyond `paths.ts` and
  `exec.ts`.
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
  that names agents and models.
- `skills/factory/` and `agents/` are prose for Claude, linked into `~/.claude` by `orch install`.
  They must only call `orch` commands; any rule that matters is enforced in TypeScript first and
  described in prose second. `tests/skill-contract.test.ts` keeps roles, agent frontmatter, and the
  reference templates consistent with the code.
- Workflow state transitions are enforced in TypeScript, never only in skill prose. A stage is
  complete only when its required artifact has been validated (location, type, structure, marker)
  and registered; replacing registered content requires `--replace`.
- Mutable state goes under `runtimePaths()` from `src/core/paths.ts`: the database at
  `databasePath()`, artifacts at `jobArtifactDir(id)`, worktrees at `jobWorktreeDir(id, repo)`.
  Never write into the install root, a skill directory, or a project repository.
- The CLI must work from any directory. Resolve the project via `findProjectRoot(cwd)`, this
  installation via `installRoot()`, and migrations via `migrationsDir()`.
- The CLI is one-shot: open the store, do one operation, print, exit. No daemons, servers, timers,
  or background work.

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

## Documentation

Keep `README.md` accurate to what is implemented. Record non-obvious architectural decisions in
`docs/decisions.md` with a short rationale.
