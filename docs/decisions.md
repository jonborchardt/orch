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
owner's commands fail with exit 4, and marks a `running` job `interrupted`. (Since decision 38
every claim rotates the token, same session or not.) `--revision <n>` adds
optimistic concurrency for callers that want to reject any intervening change.

## 17. Known advisory: `minimatch` via ESLint tooling

`npm audit` reports a moderate DoS advisory in `minimatch` 7–11.0.0 reached through `eslint@10` and
`typescript-eslint@8`. Both are at their latest versions and still depend on `minimatch@10`; the
only "fix" npm offers is a downgrade to ESLint 9. The dependency is dev-only (lint-time glob
matching of our own config) and never shipped, so it is documented here and left alone until the
tooling moves to `minimatch >= 11.0.1`. (Rechecked 2026-11-13: still the only advisory, now
reported as 10 moderate entries that are all this one `minimatch` range reached through
`eslint@10`, `@eslint/config-array`, and `typescript-eslint@8`; `npm audit fix --force` would
downgrade to ESLint 9. Unchanged decision.)

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
(Since decisions 41 and 43 that validation is `orch verify`, and the merge is recorded first.)

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

## 32. Dashboard: React + Vite + MUI client, `node:http` server, one long-running command (Phase 4)

The dashboard is the one exception to "the CLI is one-shot": `orch ui` serves until interrupted.
It is optional, loopback-only, and reads the same database the CLI writes, so nothing about jobs
depends on it. The client is React 19 + Material UI built by Vite into `web/dist` (shipped, so a
user never runs Vite); the server is `node:http` with a dozen routes rather than a framework. React
and MUI are dev dependencies: their output is static files. Hash routing, a 40-line Markdown
renderer, and polling were chosen over a router, a Markdown library, and websockets.

## 33. Dashboard actions are short ownership episodes of session `dashboard`

`approve`, `request-review`, `request-rework`, and `cancel` (`src/ops/actions.ts`) claim the job as
session `dashboard`, run the same `transition` calls the CLI would (`resume --to`, `escalate` then
`resume --to`, `cancel`), and release the job. They refuse a job whose session holds a live lease
unless the user confirms a forced takeover; a job waiting in `needs-human` is the exception because
its session is, by the skill's rules, stopped. The response always states that no session is
running the job and gives the `orch factory resume` command: the dashboard records decisions, it
does not pretend to wake anything.

## 34. Liveness is reported, not inferred

The board shows `running (lease live)` versus `last reported running` (status `running`, lease
lapsed). Both are derived from the row; neither claims a process exists. A dedicated heartbeat or
process table was rejected because there is no daemon to maintain it.

## 35. Dashboard security model

Loopback bind; `Host` must be one of the server's own origins (DNS rebinding); `Sec-Fetch-Site`
other than `same-origin`/`none` is refused; mutations need a same-origin `Origin`, JSON content
type, and a per-process CSRF token that only the page can fetch. Bodies are capped and validated
field by field. Static files are confined to `web/dist`; artifact text is served only for paths
registered in the database, so the API can never read an arbitrary file; owner tokens are stripped
from every response. There is no authentication because the server is single-user on loopback; it
must not be bound elsewhere.

## 36. Browser tests run against the real server over seeded fixtures

`tests/fixtures/dashboard.ts` builds representative state through the storage API (a live job, a
stale one, a human-blocked one, multiple rounds with long findings, a completed PR with failing CI,
a cancelled job, a fresh one). API tests start `startServer` in-process; component tests render the
React app in jsdom against a mocked `fetch`; Playwright drives Chromium against `orch ui` serving
`web/dist` from a scratch `ORCH_HOME`. CI runs Playwright on Linux only to keep the Windows job
fast; `npm run check` does not need a browser.

## 37. Evidence is pinned to a commit (Phase 5A audit)

Reviews used to be recorded against "the worktree", and `check-readonly` compared a fingerprint
only if the coordinator ran it. That left three holes: reviewers could read different commits while
the builder kept committing, a commit after the last verdict was still accepted, and a dirty file
whose _content_ changed between reviewers kept the same fingerprint. Now `artifacts.head` and
`reviews.head` record the worktree HEAD; `src/ops/gates.ts` (the only Git-aware path into
`registerArtifact`, `recordReview`, and `transition complete`) refuses `build.md`, review verdicts,
and `decision.md` from a dirty worktree, and refuses to complete `build`, `review`, or `approve`
unless HEAD still equals the recorded head and the tree is clean. The pure `transition` separately
rejects a round whose verdicts name different heads, so bypassing the gate does not help. Stage
completion also re-hashes the artifacts it depends on, so a file edited after registration is not
evidence. Workflow artifacts are locked to their stage and round (`assertStageOwns`), which is what
stops `decision.md` or an old round from being rewritten after approval. The remaining gap is a
conflict resolution inside a base-integration merge commit, which is accepted as a merge.

## 38. Every claim rotates the token

Session names are chosen by the caller, so a second process resuming under the same name used to
receive the same token and both could drive the job. A claim now always issues a fresh token; the
previous holder fails with exit 4 on its next command. "Resume" therefore means "take over from
whoever had this name", which is the only safe reading when there is no process registry.

## 39. Only approved commits leave the machine

`orch gh push` and `orch gh pr create` require the `pr` stage, a registered `DECISION: APPROVE`
with a head, and that `git rev-list --no-merges <approved>..HEAD ^<base>` is empty, so the only
commits after an approval are base-integration merges. The job branch must differ from the base
branch, and `worktree adopt` refuses a worktree on the base branch or inside the initiating
checkout. `pr complete` also requires the approval, so a human `resume --to pr` cannot finish a job
the approver never passed, and `approve complete` refuses while the last round's `consolidated.md`
counts blocking findings; a round with all-PASS verdicts but `BLOCKING: n > 0` goes back to build.

## 40. What stays cooperative

The CLI cannot stop a process from writing into any directory or the database file. It can only
decline to treat such writes as progress. Things that rest on agent behaviour, listed so nobody
mistakes them for enforced: subagents staying in the worktree (the plan now reports dirty files in
the initiating checkout so a stray write is visible), reviewers rerunning tests rather than trusting
`build.md`, builders not weakening tests, `orch doctor` being run so stale managed agent copies are
noticed, and the coordinator running `check-readonly` and `fail` when it trips.

## 41. Verification is executed by orch, from a policy the job did not write (Phase 5B)

`build.md` used to be the only record that tests ran. `orch verify` now runs the checks itself and
records a run (`verification_runs`) with every expected check rowed as `pending` before the first
one starts (`verification_checks`), so a crash leaves an obviously incomplete run. The policy is
`factory.json` at the repository root, parsed strictly into executable names and argument arrays
(`core/verification.ts`), executed with `spawnCommand` (`core/exec.ts`: PATH resolution, Windows
`.cmd` shims through `cmd.exe` with plain tokens only, timeouts with SIGKILL, capped output). The
effective policy is read from the merge base of the job branch and the base branch, which the job
cannot have authored; a human can replace it per job through the dashboard (`accept-policy`,
snapshotted in `jobs.policy`). No policy means `configuration-required`, and the gates stay shut:
inventing checks or passing by default would make the evidence worthless. Checks run in order and
stop at the first failed required check; the rest stay `pending`. Validity (`runInvalidReason`) is
recomputed at every gate from HEAD, the tree hash, the dirty list, the policy fingerprint, and the
check rows; HEAD alone is not trusted because the same commit can carry a different tree only
through uncommitted files, which is why a dirty worktree is refused outright rather than recorded.

## 42. Sensitive paths are labelled, not blocked

`core/sensitive.ts` classifies the diff (tests, test config, CI, dependencies, policy), scans the
diff of changed test files for skip/only/commented-out markers and removed definitions, and diffs
the policy. The output is a report in the plan; the only hard rules are that `consolidated.md` and
`pr.md` must name each sensitive path under a `Sensitive changes` heading, and that an
unauthorized policy change blocks approval and delivery. A generalized policy language was
rejected: a reviewer reading the diff is the control, the CLI just makes sure the diff is on the
table.

## 43. Integration is recorded first and reconciled from Git

`integrateBase` writes an `integrations` row (job HEAD, base SHA, merge base, approval commit,
valid run) before merging and completes it after (result, conflicts, changed files, `material`
from `git diff-tree --cc`, which is empty for a clean merge and lists every file whose result
matches neither parent otherwise). A `started` row on the next call means the previous process
died: `MERGE_HEAD` present means abort (nothing committed is lost), a merge commit with the
recorded parents means record it, otherwise mark interrupted. In the `pr` stage, conflicts or
material edits send the job back to `build` with the new `rework` action, so the resolution is
built, verified, reviewed, and approved like any other change; a clean merge needs only a fresh
`orch verify`. The push gate re-checks all of this against the commit actually being pushed. A
full re-review for a clean base update was rejected as cost without evidence; a review for any
edit inside a merge was accepted because the CLI cannot tell a trivial resolution from a hidden
change.

## 44. Cleanup pass: what was consolidated and what was deliberately left (Phase 5C)

Consolidated: all error classes (including `UsageError`) live in `core/errors.ts`, so the
dashboard maps them to HTTP statuses with `instanceof`; `MergeConflictError` carries the
conflicting files instead of callers parsing a message; `runTool` is `spawnCommand` with the
result reduced to stdout; CLI option parsing (`cli/args.ts`) replaced four copies of `--revision`
handling; `mutateReturning` replaced six definite-assignment assertions; the board reads reviews
and artifacts for all jobs in two queries; `inspectWorktree` derives `changedFiles` from the
name-status diff instead of a second `git diff`; push and PR creation inspect the worktree once.
A reordering of `factory.json` commands now counts as a policy change everywhere (it already
changed the fingerprint, so a run could be refused without the plan saying why).

Left alone on purpose: the seven reviewer agent files repeat the same rules block. Claude Code
loads one agent file per subagent with no include mechanism, so sharing the text would need a
generated artifact; the duplication is the cost of self-contained agents and a contract test keeps
the files consistent with `core/roles.ts`. `web/src/Actions.tsx` keeps its own stage list and
live-lease check because the client may import only types from `src/`.

## 45. Dashboard status is derived, explained from structured fields, and actions come from the server

`liveness` used to fold `completed` and `cancelled` into one green `finished`, and the only
explanation for a stopped job lived in the detail view's plan. The dashboard now derives one
execution state per job (`src/server/status.ts`), separate from the workflow stage, and a
`blocker` built only from persisted fields: the newest `job.blocked` / `stage.failed` /
`job.interrupted` / `job.cancelled` event (its `from`, `reason`, and actor), the `decision.md`
marker, the consolidation's BLOCKING count, and the newest verification run. The recorded reason is
shown verbatim and never parsed; the code-generated `max review rounds reached` reason is the only
string compared. An escalation the state cannot classify is labelled exactly that. Parsing prose,
and inferring duplicate jobs from matching titles, were rejected: both would be guesses shown as
facts. The detail API also lists the actions the workflow allows in the current state
(`allowedActions` in `ops/actions.ts`), which supersedes the client-side copy of those rules noted
in §44; the server still validates every POST. The resume affordance is a copied
`/factory resume <id>` plus the checkout to run it in: nothing on the server starts or wakes a
session, and copying mutates nothing. The command is withheld while any session holds a live
lease (the holder is named instead), because `orch factory resume` would be refused without a
deliberate `--force`; the dashboard never takes ownership by itself. Among the controls, only two
blockers promote an action: an approver escalation promotes Approve, and exhausted review rounds
promote Request rework, since that is the transition the workflow itself would make. Every other
blocker gets neutral controls rather than a guessed recommendation.
