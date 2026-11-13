# CLAUDE.md

Guidance for Claude Code sessions working on this repository. Read `README.md` for what the project
is; this file is about how to change it.

## Commands

```sh
npm run check            # typecheck + lint + format:check + test; run before finishing any task
npm run dev -- <args>    # run the CLI from source (Node strips types natively)
npm run build            # tsc -> dist/ (the linked `orch` binary runs dist/)
npm run test:coverage
```

## Architecture boundaries

- `src/cli/` parses arguments and prints. No business logic; call into `core/` and friends.
- `src/core/` holds domain types, workflow rules, and conventions. Pure functions where possible,
  no I/O beyond what `paths.ts` already does.
- `src/storage/` (future) is the only module that touches SQLite. Nothing else imports the driver.
- `src/git/` (future) wraps Git and worktree commands. `src/integrations/` (future) wraps Claude
  Code and GitHub.
- Workflow state transitions are enforced in TypeScript, never only in skill prose.
- Mutable state goes under `runtimePaths()` from `src/core/paths.ts`. Never write into the install
  root, a skill directory, or a project repository (other than the job's own worktree).
- The CLI must work from any directory. Resolve the project via `findProjectRoot(cwd)`, and this
  installation via `installRoot()`.

## Conventions

- TypeScript strict, ESM, `.ts` extensions on relative imports (tsc rewrites them for `dist/`).
- Only erasable TypeScript syntax: no `enum`, no parameter properties, no `namespace` with values.
- Node built-ins first (`node:util` parseArgs, `node:child_process`, `node:path`, `node:fs`).
- Cross-platform always: `path.join`, no hard-coded separators or drive letters, no Unix-only shell
  assumptions. When spawning tools by name on Windows, go through the shell so `.cmd`/`.exe` shims
  resolve (see `toolVersion` in `src/cli/doctor.ts`).
- Small modules, explicit types, no generalized abstractions before a second real use.
- Explicit exit codes: 0 success, 1 check failed, 2 usage error.

## Dependencies

Runtime dependencies are currently zero. Before adding one, confirm a Node built-in or a few lines
of code cannot do it. Do not add an ORM, DI container, workflow engine, queue, process supervisor,
or CLI framework. The SQLite driver decision is deferred to Phase 2; evaluate `node:sqlite` first.

## Tests

- Vitest, files in `tests/` mirroring `src/`, named `*.test.ts`.
- Prefer testing pure functions with explicit inputs (see `runtimePaths` tests). For the CLI, spawn
  `node src/cli/main.ts` with `cwd` outside the repo and `ORCH_HOME` set to a temp dir.
- Tests must never touch the real user data directories.

## Documentation

Keep `README.md` accurate to what is implemented. Record non-obvious architectural decisions in
`docs/decisions.md` with a short rationale.
