# 51. Dispatch prepares a job; the harness starts the session; the child adopts the worktree (Phase 3)

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
