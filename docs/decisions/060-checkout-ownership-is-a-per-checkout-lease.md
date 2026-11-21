# 60. Checkout ownership is a per-checkout lease, enforced at the editor hook (Phase 2, A04)

**Problem.** Job leases protect the job row. The collisions that actually happened (#45) were two
Claude Code sessions editing one checkout while its test suite ran: no job was involved, and no
`orch` command stood between the session and the file. The available identity that is reliable
and documented is Claude Code's own: hooks receive `session_id`, `cwd`, and for `PreToolUse` the
`tool_input.file_path`, and an exit code 2 from a `PreToolUse` hook refuses the tool call with
stderr as the reason. VS Code's agent window exposes no documented checkout ownership, and
parsing its session files was rejected as fragile.

**Decision.** A checkout is identified by its canonical Git directory (`git rev-parse
--absolute-git-dir`): the primary checkout's `.git` versus each linked worktree's
`.git/worktrees/<name>`, through `canonicalPath`, so spellings, 8.3 aliases, and junctions
collapse and two repositories that share a directory name never do. A claim is a JSON file under
`<data>/checkouts/` keyed by that identity and decided by the same `decideClaim` as job leases
(new, renew, reclaim after expiry, refuse while live, `--force`). A fresh claim is created with
`wx`, so two sessions racing for an unclaimed checkout cannot both win; renewals replace the file
by rename. `orch checkout hook` reads the hook payload: an Edit/Write claims the checkout
containing the file and exits 2 while another live session holds it; `SessionStart` only reports
a holder, so a read-only session never claims; `SessionEnd` releases. The hook is shipped in this
repository's `.claude/settings.json` running `src/cli/main.ts`, so every worktree of this
repository is covered by its own source without a build or install, and users enable it
elsewhere through `~/.claude/settings.json`.

**Why files, not the database.** The hook runs from whichever checkout a session is in, under
whatever `ORCH_HOME` that session has. Opening the shared SQLite store from a feature branch would
apply that branch's migrations to the user's database as a side effect of an edit. A directory of
small files has no schema, needs no migration, and is cheap enough for one write per edit.

**Rejected.** A `checkouts` table (migration for a cooperative guard; the side effect above); a
`.git/orch-session.lock` inside the repository (the project rule is that `orch` never writes into
a project checkout); tying hook claims to job sessions (job session names are chosen by the
coordinator, the hook's id is Claude Code's, so a job's own session would be refused); hooking
Bash (the command text does not say what it writes); a daemon or process registry. What remains
cooperative: Bash writes and any process that does not ask are not stopped, which the README says
in the same place it describes the guard.

**Found in live use.** The authoring session switched to a branch without `src/cli/checkout.ts`
while Claude Code still held the hook configuration it had loaded; `node src/cli/main.ts checkout
hook` then failed with "Unknown command" (a `UsageError`, exit 2), which `PreToolUse` reads as a
refusal, and every Edit/Write in the session was blocked until hooks were disabled. The first fix
exited 0 unless `src/cli/checkout.ts` existed, which silently switched the guard off on such a
branch. The shipped command now tries the checkout's source, then the installed `orch` (only after
`orch checkout list` succeeds, since an older install answers `checkout hook` with "Unknown
command", exit 2, a refusal), and otherwise warns on stderr and exits 1: Claude Code shows a
non-blocking hook error and the edit proceeds, so the absence of protection is visible without
locking the session out. Rejected: exit 2 on absence (blocks all work on every older branch) and
exit 0 (invisible). Shell-form hooks run through Git Bash on Windows, which Claude Code needs
anyway; `tests/checkout.test.ts` runs the shipped command through `bash` against this checkout,
a fake pre-checkout `orch`, and a fake capable one. Later, factory job worktrees (which have the
source but no `node_modules`) failed every hook with `ERR_MODULE_NOT_FOUND` for `drizzle-orm`, so
the source runs only when `src/cli/checkout.ts` exists and the checkout's dependencies are
installed (`node_modules/drizzle-orm` exists); otherwise the installed `orch` takes over. This is a
file test, not "try the source, then fall back": a source run that fails cannot be told apart from
a real refusal (exit 2) or a real error, and retrying after it would run the hook twice.

**Liveness without a daemon (safety review).** A lease renewed only by Edit/Write let an active
session lose its checkout: thirty minutes of reading, reasoning, or one long `npm run check` with
no edit, and another session could claim it, after which the first session's next write was
refused. Renewing on every tool call was rejected: the hook costs about a second per invocation on
a loaded Windows machine, and hooking Bash to renew would also claim for read-only sessions
unless a further mode were added. Instead the hook stores the payload's `transcript_path`; Claude
Code appends to that file on every turn and tool call, so its mtime is the session's last
activity, and a claim is live until `leaseMinutes` after the later of its lease and that mtime
(`claimExpiresAt` in `storage/checkouts.ts`). A missing or unreadable transcript extends nothing,
and CLI claims have none, so they behave as before. The residual gap is a single tool call longer
than the lease with no edit in between. The claim store itself is unchanged: hooks inherit Claude
Code's environment, so `ORCH_HOME` set only inside a Bash command does not reach them, which is
why a development session's hook wrote into the real data directory; that is the operational
location all sessions on the machine share, and tests isolate through the `ORCH_HOME` they pass
to the spawned CLI.
