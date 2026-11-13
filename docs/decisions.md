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

## 18. Artifact structure rules and markers are code (Phase 3A)

`src/core/artifact-rules.ts` maps each workflow artifact path to required headings and, for
reviews, consolidations, and decisions, a single marker line (`VERDICT: PASS|CHANGES`,
`BLOCKING: <n>`, `DECISION: APPROVE|ESCALATE`). Registration parses the marker into
`artifacts.marker`, and the pure `transition` reads it: `approve` completes only on `APPROVE`, and
`review record --verdict` must agree with the file. Skill prose can ask a reviewer for a verdict,
but only the CLI decides whether a stage is done. Other files in the artifact directory (evidence,
screenshots' notes) are unconstrained so reviewers can attach what they like.

## 19. Replacing an artifact is explicit and hashed

`artifacts.sha256` records what was accepted. Re-registering identical content is idempotent;
different content is refused without `--replace`, and the replacement is logged as
`artifact.replaced` with the previous hash. `--revision <n>` still applies. This keeps builders
from silently rewriting `build.md` under a running review while allowing the normal rework round
(`--replace`) and leaves a durable trail of what each stage accepted.

## 20. One worktree and branch per job, under the data directory

Worktrees live at `<data>/worktrees/<repo slug>/<job id>` on branch `factory/<id>-<title slug>`.
Unique indexes on `jobs.worktreePath` and (`repo`, `branch`) make double assignment impossible.
`create` is idempotent and recreates a vanished directory from the surviving branch; `remove` and
`integrate` refuse on uncommitted changes, and the branch is never deleted, so nothing `orch` does
can lose work. Ownership (the token) gates every mutating command, but it is advisory against a
process that writes into another worktree directly; that is documented rather than pretended away.

## 21. `src/ops/` composes Git, GitHub, and storage

Worktree creation and PR delivery are sequences: check ownership, act on Git or GitHub, record the
result. They do not belong in `src/cli/` (no business logic), `src/core/` (no I/O), or
`src/storage/` (no Git). `src/ops/` holds them; it is the only layer that imports from both
`src/git`/`src/integrations` and `src/storage`. `authorize()` in `storage/jobs.ts` performs the
ownership and revision check without a write so the Git action can run first.

## 22. GitHub through `gh`, with a shim for tests

No GitHub SDK: `gh` is already authenticated on the developer's machine and covers issues, PR
listing, draft creation, and `statusCheckRollup`. `src/integrations/github.ts` invokes it with
argument arrays and parses `--json`. `ORCH_GH_SHIM=<file>` swaps the executable for
`node <file> <args>` so tests run a stateful fake and never touch the network. `orch` never merges,
force-pushes, or marks ready: approval permits a draft PR, humans do the rest.

## 23. Base integration is a merge commit, never a rebase

`orch worktree integrate` fetches `origin/<base>` and merges it with `--no-ff`; conflicts abort the
merge and report the files. Rebase would rewrite a branch that may already be pushed and reviewed.
Validation after integration is the skill's responsibility (it re-runs the project's checks).

## 24. Repository identity from the configured remote URL

`describeRepo` reads `git config --get remote.origin.url`, not `git remote get-url`, which applies
`url.<x>.insteadOf` rewrites. The configured URL is what the user thinks of as "the repository";
rewrites are transport details (and the test suite uses one to point a GitHub-looking origin at a
local bare repository).

## 25. `busy_timeout` before `journal_mode`

Switching to WAL takes a lock. With five CLI processes opening the database at once, setting the
journal mode before the busy timeout produced sporadic `database is locked` failures. The pragmas
are ordered timeout first.

## 26. `orch factory next` is the skill's oracle (Phase 3B)

The coordinating Claude session never reasons about workflow state. `src/ops/factory.ts` turns the
job row, its artifacts (re-verified against disk), its worktree, and the role configuration into a
plan: the step, the agents with models and target artifacts, and the literal `orch` commands to run.
The skill prose is therefore short and the behaviour is testable without a model. Every plan command
carries `--token <token>` because shells spawned by Claude Code do not keep environment variables.

## 27. Roles and models are data

`src/core/roles.ts` is the single table of role → agent → default model → applicability, mirrored
by the agents' frontmatter (a test keeps them in sync). `<config>/factory.json` overrides models,
the UI detection patterns, and the default round limit per machine. UI reviewers are added when the
job's changed files match the patterns; `--ui`/`--no-ui` overrides. Nothing else in the code names
a model.

## 28. Reviewers are read-only, enforced two ways

Reviewer and approver agents have no `Edit` tool, and the plan carries a worktree fingerprint
(HEAD plus the sorted dirty-file list) that `orch factory check-readonly` compares after the round.
A changed worktree fails the round rather than letting a reviewer's edit slip into the diff. This
does not stop a process with filesystem access from writing anywhere; it detects it.

## 29. One factory start command

`orch factory start` creates, claims, and gives a worktree to a job in one call and returns the
token with the first plan. Three separate commands would be three chances for the coordinator to
drop the token or skip the worktree. `start` fetches the title from an issue through `gh` when only
`--issue` is given.

## 30. Managed copies as the last resort for agent files

Windows without Developer Mode refuses file symlinks, and hard links cannot cross volumes, which is
exactly the common layout of a repo on one drive and `~/.claude` on `C:`. `orch install` then writes
a copy with a trailer `<!-- orch-managed-copy: <source> -->`. Copies are recognised by that trailer
and refreshed when stale; a file without it, or with another source, is a conflict and is never
touched. Skills still link as junctions, so only the agent files lose liveness. Copying the whole
`agents` directory as a junction was rejected because it would capture the user's own agents.

## 31. Hand-off to a new session needs `--force` while a lease is live

`orch factory resume` by a different session is refused while the owner's lease has not lapsed,
including for jobs waiting in `needs-human`. The human (or the new session on their instruction)
passes `--force`, which rotates the token. Silent takeover would let two live sessions race on one
job; a lapsed lease is taken over without ceremony because its holder is presumed gone.
