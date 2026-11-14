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

(Since decision 48 this identity follows the remote and no longer binds a job to its repository.)

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

## 45. The `check-readonly` flake: what is established and what is not

**Observed.** One `orch factory check-readonly` exit 1 in `tests/factory.test.ts` (test "start /
next / status / resume / config / check-readonly with --json; usage errors exit 2") during a full
parallel `npm run check` on Windows. Only the exit code was asserted, so stderr was lost. Isolated
and later full runs passed. Two factory jobs investigated it: PR #1 was closed unmerged; PR #2
landed the unreadable-HEAD handling below.

**Confirmed defect, fixed (PR #2).** `inspectWorktree` read HEAD through `tryGit`, so a failed
`git rev-parse HEAD` in a real worktree became `head: null`, changed the fingerprint, and
`check-readonly` reported "Reviewers must not modify code" for what was a Git failure. This is a
real error-handling defect. It was never shown to be the cause of the observed run. Now
`inspectWorktree` records the first failing step and Git's error in an optional `problem` field.
The steps are `rev-parse --show-toplevel`, the canonical-path comparison, `--git-common-dir` for
both sides (replacing `sameRepository`, which swallowed the error), and `rev-parse HEAD`.
`isWorktree` and every other caller behave as before; the fingerprint inputs (HEAD plus the sorted
dirty list) are unchanged. `check-readonly` treats a missing HEAD as an inspection failure: still
exit 1, message "Worktree is missing or unreadable at <path>: <step>: git rev-parse failed in
<path>: fatal: ...", never blaming a reviewer. The regression test `check-readonly reports a
failed inspection with its Git error, not as a reviewer write` covers an unreadable HEAD and a
`.git` file pointing at a missing gitdir; `check-readonly catches a reviewer that changed the
worktree` keeps the real-modification message for an added file and a moved HEAD.

**Reconstructed, not observed.** A second Claude Code session was applying the Phase 5C edits
(later 6728edc) to the same checkout while the suite ran; its transcript records the edits with
timestamps. Between 19:17:55.2Z and 19:17:59.7Z `src/git/worktree.ts` was invalid on disk (first
the `realpathSync` and `resolve` imports removed while `samePath` still used them, then `samePath`
deleted while `inspectWorktree` still called it). Imports still resolved, so modules loaded; any
CLI process started in that window threw `ReferenceError` from `inspectWorktree`, and `printError`
maps a non-`OrchError` to exit 1. The failing test ran in roughly 19:17:51-19:18:07 and
`check-readonly` sits about two thirds of the way through it, so the timing fits. Rebuilding the
tree at 6728edc with `worktree.ts` in each half-edited state and running `check-readonly` 10 times
per tree gave exit 1 10/10 for each (with `ReferenceError: resolve is not defined` and
`ReferenceError: samePath is not defined`), and exit 0 10/10 on the good tree. The original run left
no artefact that ties it to this: the mechanism is plausible and reproducible, not established as
the cause.

**Not reproduced under load.** Load runs used a frozen snapshot of b88621d, so edits could not
interfere. H1, inspection failure: looping `check-readonly` 300 times against a live job (the first
6 minutes alongside a full suite run) gave 300/300 exit 0, slowest 7.0 s, far under `spawnTool`'s
120 s timeout; the `check-readonly` tests run 6 times alongside a second full run gave 12/12. H2,
the dirty list changing: no command in the test writes into the worktree between `factory status`
and `check-readonly`, and the artifact goes under `ORCH_HOME`. Test isolation: the store, clone,
bare origin, and CLI `ORCH_HOME` are per test, worktrees live under that home, `git worktree prune`
runs only in the test's own clone, and each file runs in its own Vitest worker, so `ORCH_GH_SHIM`
is not shared. PR #1 saw 0 of 14 runs fail; PR #2 0 of 312.

**Unverified.** The cause of that one run. Treat a recurrence as unexplained unless the worktree
really changed. The CLI test's assertion now prints stderr: a `ReferenceError` or `SyntaxError`
means another mid-edit tree; a `rev-parse ...: fatal: ...` line names the Git step that failed.
Operationally: one Claude session per checkout (a parallel session takes its own worktree), and no
edits to a checkout while its suite runs.

## 46. `orch init` writes a policy; it never makes one trusted

Onboarding a repository is a plain file write: `orch init` validates the checks the developer names
(or the `package.json` scripts they explicitly accept with `--from-package-json`) through the same
`parsePolicy` the gates use, writes `factory.json` atomically (temp file and rename, refusing to
replace an existing file without `--force`), and prints the review/commit/check sequence. It never
commits, never pushes, never runs a check, and does not touch the baseline rule in `ops/verify.ts`:
a policy written into a job worktree is still just a proposed change the plan reports as
`authorization: required`. A placeholder or empty starter policy was rejected because a committed
empty policy leaves every job at `configuration-required`; guessing commands from a language or
lockfile was rejected because an unreviewed guess that happens to pass is exactly the policy the
trust model exists to prevent. `orch init --check` answers the question the factory will ask by
reusing its code rather than approximating it: `baseRef` picks the same start point a new job's
worktree gets (`origin/<branch>` as last fetched, else the local branch, so a repository without
an origin needs only the commit), `policyAt` reads the file at that commit exactly as
`effectivePolicy` does at the merge base, and `whichSync` resolves executables without running
them. A test starts real jobs and asserts the check and `effectivePolicy` agree on the commit and
fingerprint. `orch doctor` carries a one-line summary of the same result.

## 47. Dashboard status is derived, explained from structured fields, and actions come from the server

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

## 48. Delivery ends with GitHub's verdict for the PR head, read by the CLI (post-PR CI)

The first real factory job reported success with PR #1 failing CI, because `pr` completed the job
once a PR URL was recorded. A `ci` stage now follows `pr`, and completing it requires
`jobs.ciStatus = passing` recorded for `jobs.ciHead` by `orch gh ci`, with `ops/gates.ts` adding
that `ciHead` is still the worktree HEAD. The rollup is not taken from `gh pr view`
(`statusCheckRollup` describes whatever the head is at that moment); the command reads
`/commits/<sha>/check-runs` and `/commits/<sha>/status` for the SHA it then records, so a verdict
can never be borrowed from another commit, and it reads classic protection plus rulesets to know
which checks are required. Without that list every reported check is required and an empty or
skipped-only list is not a pass: it waits through a short grace window (checks register a few
seconds after a push) and then escalates, because inventing success is exactly the failure mode
being fixed. Failures that a builder can act on (`failure`, `timed_out`) save the Actions job log
under the artifact directory and go through the existing `rework` action, so the repair is built,
verified, reviewed, approved, and pushed to the same PR like any other change; the pure
`transition` counts them in `jobs.ciRepairs` and escalates at `jobs.maxCiRepairs` the way review
rounds escalate at `maxRounds`. Outcomes that are not code defects (cancelled, startup failure, a
required check that never reported, a closed PR, a head that moved outside the job) escalate
without spending a repair, and a `gh` failure records nothing. Pending checks record only the
observation: the CLI stays one-shot and never sleeps or polls, the coordinator re-runs it or
releases the job, and a resumed session re-reads GitHub rather than trusting the stored rollup.
Three columns were added (`ciHead`, `ciRepairs`, `maxCiRepairs`) because the SHA binding and the
budget must be visible to the pure transition; events alone would have moved the rule into prose.
`resume --to completed` was opened for exactly one case, a `ci` escalation with no checks at all
(or a PR a human already merged), so a repository without CI has a human recovery path that cannot
be used to step over a failing or pending check. Rejected: completing `pr` when the rollup looked
green at creation (that is the bug), a repository-side declaration of required checks in
`factory.json` (GitHub already holds that configuration and it would widen the policy format),
re-running failed workflows automatically (indefinite retries with no new information), and
treating a CI failure as a lighter "fix and push" path that skips review (edits after an approval
are unapproved code, decision #39).

## 49. A job is bound to its repository by Git common directory, not by remote identity

The first real factory run created a job in a repository without a remote (identity `orch`, the
directory name), then gained a GitHub `origin`. `describeRepo` now reported `github.com/<o>/orch`,
every gate compared that to `job.repo` and refused the job's own checkout, and only the manual
`orch job repo` command could recover it. The remote identity was doing two jobs: naming the
repository for grouping and PR delivery (where it belongs) and proving that a path is the job's
repository (where it is wrong, because it changes whenever the remote does).

`ops/repo.ts` separates them. The stable local identity is the canonical Git common directory of
the recorded checkout (`commonGitDir`, through `canonicalPath`, so case, 8.3 aliases, junctions,
and spaces compare equal); the checkout and all its linked worktrees share it, and no remote
operation moves it. `job.repo` stays the remote identity: it follows the remote (refreshed on the
next authorized mutation and recorded as `repo.repointed`), groups jobs in the dashboard, is
checked against GitHub before a PR, and is how `--repo <other clone>` is recognised. A
directory-name identity never matches another repository: nothing proves two directories called
`proj` are related. Mismatches that cannot be reconciled say what is stored, what was found,
whether the recorded checkout still exists, and why no remote can bridge them.

Rejected: storing the common directory as `job.repo`. It would change the persisted format for
every existing row, turn worktree slugs and dashboard groups into filesystem paths, and break
`--repo <other clone>`, for no safety the on-demand comparison does not already give. No schema
change was needed: `repoPath` was already the anchor; it was simply not what the gates compared.
A changed identity at the recorded path is adopted only on evidence, because nothing stored tells
a remote change apart from an unrelated repository placed at that path. The job's worktree is the
evidence: it was created from the job's repository and still names its common directory, so the
checkout must share it; a worktree that resolves elsewhere, or no longer resolves at all, means the
checkout was replaced and every mutation (including `orch job repo`) refuses. Without a worktree
only an operator can vouch, so automatic reconciliation stops and `orch job repo` is the explicit
confirmation. The check runs before `setRepo`, so a refused checkout never reaches the row.

## 50. CI: one Linux job for every check, the Windows suite split across runners

**Measured.** Hosted runners for this private repository have 2 cores, so Vitest's default worker
count (cores - 1) ran all 22 files on one worker: per-file durations summed to the wall clock on
both platforms. Windows Vitest was 16 of the 18 minutes of a PR run; every other step together was
under two minutes. On Windows, 2 workers doubled each file's duration and gained nothing, and 3
workers gained about a quarter while tripling per-test times (the suite spawns Git and Node for
nearly every assertion, and process creation is what the two cores spend their time on). On Linux,
3 workers cut the suite from 3m14s to 2m12s.

**Decision.** Platform-independent checks (typecheck, lint, format, migration drift, coverage,
Playwright) run once, on Ubuntu, where they were already fastest. Windows runs the whole Vitest
suite, because the slow files are exactly the Git, worktree, path, and process tests that have
found real Windows defects; they are split across four runners by explicit groups of measured
duration (`ci` alone, `factory` + `integration`, `audit` + `verify` + `sensitive`, and the rest via
`--exclude`), each on Vitest's default single worker. The rest group also builds and smoke-tests the
CLI from `dist/`. A new test file runs in the rest group until someone rebalances. Vitest's own
`--shard` was rejected: it distributes by path hash and put 60% of the Windows time in one shard.
The critical path after the change is `tests/ci.test.ts` alone (about five minutes on Windows);
splitting that file is the next lever, not more workers.

**Found on the way.** With 3 Windows workers, `tests/install.test.ts` once reported no conflict for
a user file. `sameFile` compared `stat().ino` as doubles; NTFS file ids are 64-bit and lose low
bits above 2^53, so two files created back to back can compare equal and a conflicting agent file
passes as a hard link. It now compares bigint stats. The flake was latent, not caused by the
workflow change.

## 51. Dispatch prepares a job; the harness starts the session; the child adopts the worktree (Phase 3)

**Established by experiment** (VS Code 1.146.0, Claude Code 2.1.323, extension 2.1.322, Windows 10,
2026-11-14; details in `docs/session-launch.md`). A session in VS Code's Agents window has the
host's documented session tools (`create_session`, `list_sessions`, `get_session_context`,
`send_message`, `get_current_session`). `create_session` with `relationship: independent` starts a
separate session, visible in the Agents window, with an initial prompt, and returns an
`agent-host-session://` link. It cannot be pointed at an existing worktree: a linked-worktree path
or `file://` URI passed as `workspace` opened the session in the project root (the primary
checkout) both times. With `worktree: true` it creates its own worktree at
`<repo>.worktrees/<slug>` on branch `agents/<slug>` and starts there. Subagents, `claude -p`, and
`claude --bg` are not Agents-window sessions; `code --agents <folder>` opens the window but takes no
prompt; `agent-host-session://` has no operating-system URI handler (`vscode://` and `claude-cli://`
do).

**Decision.** `orch factory dispatch` validates the target (`checkReadiness`, base branch) and
creates the job, nothing else: no claim, no worktree, no process. The skill calls `create_session`
with the repository as the workspace and `worktree: true`; the child's `orch factory resume
--adopt <toplevel>` records the host-made worktree through the existing `adoptWorktree` (same
repository, on a branch, not the primary checkout, not another job's). Rejected: creating the
ORCH worktree first and opening the session on the project root (the child's own shell would run
in the user's checkout, which is exactly what the worktree model exists to avoid), and spawning
`claude --bg` from `orch` (a process supervisor the CLI model forbids; the fallbacks are printed as
commands and never claimed as started sessions). Duplicate protection is by (repository, issue)
among active jobs, so retrying a dispatch after a failed launch returns the same job; title-only
dispatches are new jobs, as `factory start` always was.

**Session association is an event, not a column.** `session.attached` events carry the provider,
ref, and cwd; the newest is the current session and earlier ones are history. Attaching needs the
owner token while the job is claimed and none while it is unowned, because the launcher records
the session it created before the child has claimed anything; it is metadata, so the relaxation
grants no workflow power. A schema column was rejected: nothing queries it transactionally, and the
event log already carries history. Navigation is derived per provider from documented URIs only;
where none exists (the host link in a browser) the UI copies the reference and says why.

## 52. Only `orch gh ci` records a CI head; rollups from `pr create` and `pr status` carry none

**Observed (Phase 1 validation, scenario A06).** A coordinator was killed while CI was pending; its
orphaned shell still ran `orch gh ci`, which recorded `passing` for the head. The session that
resumed after the lease lapsed received the plan "Required checks passed for <sha>. Complete the
job." and completed without reading GitHub again. That completion rested on a genuine per-commit
verdict, but the same two columns (`ciStatus`, `ciHead`) were also written by `orch gh pr create`
and `orch gh pr status --token` from the `gh pr view` rollup, where "no failing and no pending
check" reads as `passing` even when every check was skipped. A job could therefore complete `ci`
on a rollup, never having run the per-commit evaluation that decision 48 made the only source of
truth (every reported check required, skipped-only is not a pass, grace window, SHA binding).

**Decision.** `ciHead` is written only by `orch gh ci`. `pr create` and `pr status --token` still
record the rollup (`ciStatus`, `ci.observed` event) for the dashboard, but with `head: null`, so
the pure transition (`no CI verdict has been read for the PR head`), the Git-aware gate
(`ciHead` must equal HEAD), and the plan (`ci.current`) all require a fresh `orch gh ci` before
`complete`. Rejected: a schema change to record the source of each observation (the head column
already distinguishes them once only one writer sets it). Decision 53 then removed the remaining
case in which a stored verdict completed the stage.

## 53. `orch gh ci` completes the ci stage itself; a stored verdict never does

**Observed (Phase 1 acceptance closure).** After decision 52 a resumed session could still complete
`ci` on a stored `orch gh ci` verdict for the current HEAD without reading GitHub again. The verdict
was genuine for that commit, but completion is a claim about the PR, and between the read and the
completion the PR can be closed, its head can move (a push from outside the job), or a check can be
rerun for the same commit and fail. `reconcileCi` detects all three; the stored-verdict path skipped
it. The gate also had no way to tell a stored verdict from a fresh one without a timestamp
heuristic.

**Decision.** The read and the completion are one operation. `reconcileCi` calls `completeCi`
(`ops/gates.ts`: clean tree, `ciHead` equals HEAD, valid verification run, authorized policy, then
the pure transition) in the same call that evaluated GitHub's checks for the PR head, and
`transitionGuarded` refuses `complete` in the `ci` stage outright, so the CLI, the plan, and a
resumed session have exactly one way to finish: run `orch gh ci`, which reads first. The plan for
`ci` therefore always lists `orch gh ci`; a recorded passing verdict is mentioned as something to
confirm, not reuse. Skipped-only check runs are now `none` even when a human made the checks
required (GitHub's merge button would count them): the factory does not infer success from a check
that did not run, and the human close-out (`resume --to completed`, recorded `acceptedByHuman`)
remains the explicit, distinguishable exception. The normal flow makes no extra API call (the
passing read already happened); only a resumed session with a stored verdict pays one read, which is
the read it was missing. Rejected: a freshness window on `ciCheckedAt` (a timer standing in for a
fact that is cheap to re-read), and re-reading GitHub inside `orch job transition complete` (a
"transition" that calls the network and can rework the job would surprise every caller).

## 54. Test runs own their resources: free ports, per-run state, scratch homes (Phase 2, C02)

**Audit.** Vitest fixtures were already `mkdtemp` directories (stores, repositories, bare origins,
`gh` shims, worktrees under the store's home) and the CLI helper always set `ORCH_HOME`, so two
Vitest runs did not collide on state. Three things were fixed across runs: the Playwright suite
wrote its state to `e2e/.state.json` inside the checkout and listened on 4799 unless
`ORCH_E2E_PORT` said otherwise, so two runs in one checkout fought over both; a test that failed
before its own `rmSync` left its temp directories behind (146 `orch-*` directories were sitting in
this machine's `%TEMP%`); and nothing stopped a test that reached `runtimePaths()` without an
explicit home from opening the developer's database if `ORCH_HOME` happened to be set in the
shell (a second validation campaign on this machine runs with exactly such a shell).

**Decision.** `e2e/global-setup.ts` starts `orch ui` on port 0 (or the pinned `ORCH_E2E_PORT`,
failing with a message naming the port when it is in use rather than connecting to whatever is
already there), reads the URL the server prints, and writes `{home, pid, ids, url}` to a state
file under the run's own scratch home; the path travels to the workers and the teardown as
`ORCH_E2E_STATE`, and the spec sets `baseURL` from it with `test.use`. `ORCH_E2E_KEEP=1` keeps the
home. `tests/setup.ts` runs before every Vitest file: it points `ORCH_HOME` at a scratch
directory and removes every directory the file created through `tempDir()` in `afterAll`, which
Vitest runs after failures as well; a directory held open by an unclosed store is left rather than
fought over. Two concurrent `npx playwright test` runs from one checkout passed with no shared
resource (see the Phase 2 report).

**Left alone.** Playwright's `test-results/` and `playwright-report/` stay where they are: they
are per checkout, the rule is one session per checkout, and moving them would hide the traces
developers look for. A global lock across runs was not needed once nothing was shared.

## 55. The dashboard shows CI with its commit, and close-out is the transition's own rule (Phase 2, C03)

**Found.** The board and detail showed `jobs.ciStatus` alone, so a rollup could read as current
after the PR head moved, a ci-stage escalation was an unclassified `Escalated from ci`, the repair
budget and failure logs that `orch gh ci` records were invisible, a job completed by `resume --to
completed` looked like a passing build, and the only human close-out lived in the CLI.

**Decision.** One read model, `ciView` (`src/server/status.ts`), built from persisted fields: the
rollup columns (`ciStatus`, `ciHead`, `ciCheckedAt`, `ciRepairs`, `maxCiRepairs`), the newest
`ci.observed` event (an `orch gh ci` reconciliation carries `outcome`, `reason`, and `failures`; a
`pr status` observation does not and contributes nothing), and the `job.completed` event
(`acceptedByHuman`, or a `head` for GitHub's verdict, or neither for jobs older than the ci stage).
The verdict is shown with its SHA; the detail compares it to the worktree HEAD and marks a stale one,
the board does not inspect worktrees and says so with `current: null`. A ci escalation is its own
blocker kind, classified from the reason code (`max CI repair cycles reached`) and the last
outcome, never from prose. Close-out: `cannotAcceptDelivery` is extracted from the pure transition
and used both by `acceptDelivery` and by `allowedActions`, so the dashboard offers Accept delivery
exactly where `resume --to completed` would succeed; the action requires a reason, is never
primary, and the result is labelled a human close-out everywhere. No schema change: every field
was already persisted (decision #48 made sure the SHA binding and the budget were columns).

**Rejected.** A `closed`/`merged-by-hand` status column (the newest observation already records
it); reimplementing the gate in React (the client renders the server's list and only decides
prominence); promoting Request rework for CI infrastructure failures (not a code defect); any
automatic merge or ready-for-review action.

## 56. A PR closed without merging is its own state

`jobs.prState` knew `draft`, `ready`, and `merged`; `prWorkflowState` answered `undefined` for a
closed PR, and `recordCi` skips an undefined state, so a factory PR that a human closed stayed
recorded as `draft` for ever. `closed` is now the fourth value. It is written only from GitHub's
answer (`orch gh pr status`, `orch gh ci`) or by the owner through `orch job pr`; cancelling a
job never implies it, because a cancelled job's PR may well still be open. The pure transition
refuses to complete the `ci` stage, and `resume --to completed` refuses to accept delivery, while
the PR is `closed`: a closed PR is not a deliverable whatever its checks said. Reopening is
observed the same way (the next observation records `draft` or `ready` again). Historical rows and
events are untouched: a job whose PR was closed before this change keeps `draft` until the next
authoritative observation, and the `pr.recorded` / `ci.observed` log is append-only. No migration:
the column is free text typed in TypeScript.

## 57. Supersession is a column on the old job, recorded explicitly

The board showed several jobs with the same title (a cancelled attempt and its restart) with no
way to tell which replaced which; the only trace was free text in a cancel reason. `jobs.supersededBy`
now names the replacement, written by `orch job supersede <old> --by <new>`, never inferred. A
column rather than an event-only record because the relationship is state the board and `orch job
show` query (decision 15: events are an audit log, columns hold state); the `job.superseded` event
keeps the history of changed replacements. The rule set is deliberately small: same repository, no
self-reference, no loop, nothing deleted or merged, no generalized dependency graph. The command is
a short ownership episode (decision 33), shared with the dashboard actions through `withLease`, so
a cancelled or abandoned job needs no manual claim and a live session's lease is still respected.
Rows created before the migration carry null and are never back-filled.

## 58. CI: every page, one bounded re-run per head, and a cadence the CLI computes

**Pagination.** `listChecksFor` read `check-runs?per_page=100` once; a commit with more runs (large
matrices do this) was evaluated on a partial list, and a failed required check on the second page
would have passed unnoticed when the list was unconfigured. It now reads every page of both the
check-runs and the combined-status endpoints with `gh api --paginate --slurp` (one JSON array of
pages; needs `gh` 2.41, December 2023). A page failure fails the call, so a partial view is never
recorded. Several runs of one name are either attempts of one check or independent checks, and
GitHub says which: a re-run creates a new check run with a higher id in the same check suite, so
runs sharing a suite and a name collapse to the newest; runs with the same name in different suites
(two workflows posting the same job name), or without a suite id, count at their worst instead of
whichever came first. Rejected: "worst of all runs with the name" (a superseded failure would
outvote the attempt that replaced it, and a re-run could never pass while GitHub still listed the
old run) and `filter=all` (the default `latest` already hides most superseded attempts; the suite
rule only has to be right about the ones it does return).

**Re-runs.** Decision 48 rejected re-running failed workflows as "indefinite retries with no new
information". The bound is what was missing. A flaky test or a lost runner cost a repair cycle:
builder, three reviewers, approver, and a push, to "fix" something that was not broken, with
`maxCiRepairs` at two. `orch gh ci` now requests `gh run rerun <run> --failed` once per PR head for
a required Actions check that concluded `failure`, `timed_out`, `cancelled`, `startup_failure`, or
`stale`, only after every other required check has finished (GitHub refuses to re-run a run in
progress), records it as `ci.rerun` with the head, the run ids, and the check-run ids it replaces,
and then waits. A second failure of the same commit is new information: it goes to `rework` as
before; a second cancellation still escalates. The budget is counted from events per head, so a
repaired commit gets its own single re-run, a resumed session does not get another, and the total
is bounded by `maxCiRepairs + 1`. Until GitHub reports the new attempt the replaced check-run ids
are ignored for the grace window, so a poll that lands between the request and the new runs cannot
spend a repair on the old verdict. Commit statuses from other CI systems, `action_required`, and
checks that never reported are not re-run: there is nothing to re-run or it would not help.
Rejected: classifying a `failure` as flaky from its log (a signature list would be guessed, not
measured; the deterministic rule "fail twice" needs no classifier), a configurable budget (one
value, one column less), and re-running the whole workflow (`--failed` keeps the passing jobs'
verdicts, which are still for the same commit).

**Cadence.** "Wait about a minute, release after roughly 30" was prose. The result now carries
`waitSeconds` (60 s for the first five observations of a head, then 120, 180, 240, capped at 300)
and the plan carries `sessionPolls` (observations since the current claim) and `release`, which
turns the plan's only command into `orch job release` after 20 pending observations in one
session; `orch factory resume` starts the count again, so a resumed session gets its own budget
and an interrupted one loses nothing. The CLI still never sleeps or loops; it only says how long.
Rejected: refusing a call that comes too soon after the previous observation (the only caller is
the skill, which now has an exact number; a human running the command twice is harmless, and a
refused call would read like a GitHub failure).
