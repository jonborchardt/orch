# Decisions

Short records of choices that are not obvious from the code. Newest last.

## 1. Single package, no workspaces (Phase 1)

One `package.json`, one `tsconfig`. The dashboard, skills, and agents will live in subdirectories
of the same package until something actually needs separate publishing or dependency isolation.

## 2. Node native type stripping instead of `tsx`

Node runs `.ts` files directly. `erasableSyntaxOnly` in `tsconfig.json` guarantees source stays
strippable (no enums, parameter properties, or namespaces). Relative imports use `.ts` extensions;
`rewriteRelativeImportExtensions` makes `tsc` emit `.js` in `dist/`. One less dependency and one
less execution path to debug. (Minimum engine raised to Node 24 in decision 11.)

## 3. `node:util` `parseArgs` for the CLI

A handful of commands does not justify a CLI framework. All options are declared once in
`src/cli/main.ts`; subcommands pick what they need. Help text is a string. Revisit only if the
option set becomes unmanageable.

## 4. Runtime state in OS user directories, `ORCH_HOME` override

Windows: `%APPDATA%\orch` (config) and `%LOCALAPPDATA%\orch` (data). macOS: Application Support.
Linux: XDG. One env var redirects everything, which is how tests and development installs avoid
the real directories. Nothing mutable is ever written into the package install root or a Claude
skill directory, so `npm link` and junction-linked skills stay safe.

## 5. Repository detection via `git rev-parse --show-toplevel` from the invoking cwd

Simplest correct answer, handles worktrees and nested dirs, and the CLI is useless without Git
anyway. Install location is derived from `import.meta.url`, so it is identical from `src/` and
`dist/` and independent of cwd. A job's repository identity is the normalized `origin` URL
(`github.com/org/repo`), falling back to the directory name, so clones of one repository share jobs.

## 6. Subprocesses: argument arrays, with one narrow cmd.exe path (supersedes Phase 1)

Phase 1 ran `execSync('<tool> --version')` through the shell. Phase 2 replaced that with
`src/core/exec.ts`: tool names must match `^[a-z][a-z0-9-]*$`, the executable is resolved on PATH
(honouring PATHEXT) by our own code, and arguments are always arrays. Only `.cmd`/`.bat` shims,
which cannot be started without cmd.exe, go through `cmd.exe /d /s /c` with the resolved absolute
path quoted and arguments restricted to `[\w.=:/-]`. Git is always invoked with `execFileSync` and
an argument array. No shell string is ever built from user input.

## 7. Exit codes

0 success; 1 failed check, validation, or illegal workflow transition; 2 usage error; 3 not found;
4 ownership (owned by another session, bad or stale token, stale revision). Distinct codes let a
skill branch on "someone else owns this" without parsing messages. With `--json`, errors are
printed to stderr as `{"error":{"type","message","exitCode"}}`.

## 8. Global skills via links, not copies or plugins

`orch install` creates `~/.claude/skills/<name>` and `~/.claude/agents/<name>.md` links to this
repo. Skill directories use junctions (`fs.symlink(target, path, 'junction')`), which need no
elevation or Developer Mode on Windows and degrade to ordinary symlinks elsewhere. Junctions cannot
point at files, so agent files use a file symlink and, when that is refused (Windows without
Developer Mode), a hard link on the same volume. Edits here are live everywhere (hard links share
the inode, so they are live too). The installer owns only entries that resolve back to this repo,
reports everything else as a conflict, and never modifies project `CLAUDE.md` files or other skills.

## 9. SQLite via built-in `node:sqlite` (resolves the Phase 1 deferral)

`node:sqlite` (`DatabaseSync`) is synchronous, needs no native build, and imports without an
experimental warning on Node 24. Synchronous access matches the CLI's one-shot model, and
`BEGIN IMMEDIATE` transactions plus a 5 s `busy_timeout` serialize concurrent CLI processes on
SQLite's write lock. WAL mode lets readers (`job list`, `job show`, a future dashboard) run while a
writer holds the lock. `better-sqlite3` (native build) and `sql.js` (no multi-process safety) were
rejected. All access sits behind `src/storage/`.

## 10. Drizzle ORM 1.0.0-rc.5 pinned exactly

Drizzle's `node:sqlite` driver (`drizzle-orm/node-sqlite`) only exists in the 1.0 line; the latest
stable `0.45.x` does not ship it. The rc is pinned exactly (`drizzle-orm` runtime,
`drizzle-kit` dev) rather than ranged, so upgrades are deliberate. The schema is TypeScript
(`src/storage/schema.ts`); `drizzle-kit generate` produces versioned SQL under `drizzle/` that is
committed and shipped; `migrate()` applies pending migrations when the CLI opens the database.
`drizzle-kit push` is never used against the runtime database. Records use Drizzle's inferred
types; nothing outside `src/storage/` imports the driver.

## 11. Minimum Node 24

`node:sqlite` is only unflagged and warning-free on Node 24. Rather than claim untested support for
22.x, `engines.node` and `orch doctor` require `>=24.0.0`. Development and CI run Node 24.

## 12. Stage and status are separate columns

`stage` says where in the workflow a job is (`spec`, `build`, `review`, `approve`, `pr`,
`needs-human`, `completed`); `status` says what is happening there (`pending`, `running`,
`blocked`, `interrupted`, `completed`, `failed`, `cancelled`). A job can be `review`/`interrupted`.
`needs-human` is modelled as a stage with `status = blocked` and a `returnStage` so resumption
knows where to go back to.

## 13. Transitions are a pure function

`transition(job, action, ctx)` in `src/core/workflow.ts` takes the job row, the requested action
(`start`, `complete`, `fail`, `escalate`, `resume`, `cancel`), and the registered artifacts and
reviews, and returns a patch plus events or throws `WorkflowError`. It does no I/O, so the whole
contract is unit-tested without a database. `src/storage/jobs.ts` runs it inside an immediate
transaction, bumps `revision`, renews the lease, and appends the events. There is no generic
workflow engine; the sequence is code.

## 14. Required artifacts gate stage completion

A stage completes only after its required Markdown artifact (`spec.md`, `build.md`,
`round-N/consolidated.md`, `decision.md`, `pr.md`) has been registered through `orch job artifact
add`, which checks the file is inside the job's artifact directory, is `.md`, exists, and is
non-empty. The database stores paths and sizes, not content. A file merely existing on disk is not
evidence of completion. The `pr` stage additionally requires a recorded PR (`orch job pr`).

## 15. Append-only events, not event sourcing

The `events` table is an audit log (`job.created`, `stage.started`, ...) written in the same
transaction as the state change. Current state lives in `jobs`; nothing is reconstructed from
events. A cascade delete is declared but no command deletes jobs.

## 16. Ownership by lease with explicit renewal

There is no daemon to renew leases, so: `claim` records the session, a random token, and
`leaseExpiresAt = now + leaseMinutes` (default 30). Every successful mutation by the token holder
renews the lease by the same length; `claim` by the same session renews explicitly. A different
session may claim only after expiry (or with `--force`), which rotates the token so the previous
owner's commands fail with exit 4, and marks a `running` job `interrupted`. `--revision <n>` adds
optimistic concurrency for callers that want to reject any intervening change.

## 17. Known advisory: `minimatch` via ESLint tooling

`npm audit` reports a moderate DoS advisory in `minimatch` 7–11.0.0 reached through `eslint@10` and
`typescript-eslint@8`. Both are at their latest versions and still depend on `minimatch@10`; the
only "fix" npm offers is a downgrade to ESLint 9. The dependency is dev-only (lint-time glob
matching of our own config) and never shipped, so it is documented here and left alone until the
tooling moves to `minimatch >= 11.0.1`.
