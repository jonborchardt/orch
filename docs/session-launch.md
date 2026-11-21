# Independent session launch: capability assessment and evidence

What the installed VS Code and Claude Code can and cannot do about starting an independent agent
session for a factory job, established from the official documentation and from experiments run on
2026-11-14 in this environment:

| Component                | Version                                              |
| ------------------------ | ---------------------------------------------------- |
| VS Code                  | 1.146.0 (x64, Windows 10 Pro N 10.0.19045)           |
| Claude Code CLI          | 2.1.323                                              |
| Claude Code VS Code ext. | anthropic.claude-code 2.1.322                        |
| Initiating session       | VS Code Agents window, Claude harness, in a worktree |

> **Later note (2026-11-21).** This page records what was established on 2026-11-14 for
> _dispatch_: one session handing a job to another, visible session. Its conclusion still holds
> for dispatch and for the recovery worker, neither of which starts a Claude process. Since then
> one component does: the foreground factory controller (`orch start`, `orch do`, `orch resume`)
> starts a headless `claude -p "/factory <job>"` child for the ticket it is working on, the kind
> listed below as "Headless CLI". It is not an Agents-window session, cannot be messaged, and
> lives only while the controller's command runs. See
> [decisions/2026-11-21-foreground-factory-runner.md](decisions/2026-11-21-foreground-factory-runner.md)
> and [workflow.md](workflow.md#factory-controller). The text below is unchanged.

## Session kinds, and which one a factory job needs

| Kind                                         | Independent of the parent? | In the Agents window? | Can be given a cwd / prompt?                                 |
| -------------------------------------------- | -------------------------- | --------------------- | ------------------------------------------------------------ |
| Claude Code subagent (`Agent` tool)          | No: nested in one session  | Read-only chat only   | cwd of the session (or `isolation: worktree`)                |
| Nested agent invocation                      | No                         | Read-only chat only   | Same                                                         |
| Headless CLI (`claude -p`)                   | Process, not a session UI  | No                    | Shell cwd, prompt                                            |
| Background CLI (`claude --bg`)               | Yes (Claude's supervisor)  | No (`claude agents`)  | Shell cwd, prompt, `--worktree`                              |
| Separate Claude Code session (extension tab) | Yes                        | No (extension panel)  | `vscode://anthropic.claude-code/open?prompt=` only pre-fills |
| **Agents-window session (`create_session`)** | **Yes**                    | **Yes**               | **Project + `worktree: true`, prompt, title**                |
| VS Code extension-host task                  | Not an agent session       | No                    | n/a                                                          |
| ORCH factory job                             | A job, not a session       | n/a                   | Driven by whichever session resumes it                       |

A factory job needs the bold row: a separate, navigable session that starts in an isolated worktree
with a known prompt. Everything else is either nested in the parent or invisible to VS Code.

## Documented interfaces

- VS Code, [Agents overview](https://code.visualstudio.com/docs/agents/overview) and
  [tools](https://code.visualstudio.com/docs/agents/run/tools): Copilot and Claude harness
  sessions have built-in session-management tools that list sessions, create sessions or nested
  sessions (`currentSession` versus `independent`), read another conversation's recent context,
  and send messages; independent sessions can use a new worktree when requested.
  [Subagents](https://code.visualstudio.com/docs/agents/run/subagents) are not sessions: they
  appear as read-only chats inside the delegating session.
- In this harness those tools are `create_session` (`prompt`, `title`, `relationship`,
  `workspace`, `worktree`, `model`), `list_sessions` (status, working directory, project, git,
  `openLink`), `get_session_context`, `send_message`, `get_current_session`. `code --agents
[folder]` opens the Agents window with a new session for a folder but takes no prompt.
- Claude Code: [background agents](https://code.claude.com/docs/en/agent-view) (`claude --bg`,
  `claude agents --json` with `sessionId`, `cwd`, `state`), [worktrees](https://code.claude.com/docs/en/worktrees)
  (`--worktree`, `.claude/worktrees/<name>`, `worktree-<name>`), [headless](https://code.claude.com/docs/en/headless)
  (`session_id` in `--output-format json`, `--resume`), [deep links](https://code.claude.com/docs/en/deep-links)
  (`claude-cli://open?cwd=&q=`, prompt pre-filled, not sent), the VS Code extension's
  `vscode://anthropic.claude-code/open?prompt=&session=` (opens a tab in the focused window,
  pre-fills, resumes a session of the open folder), and [subagents](https://code.claude.com/docs/en/sub-agents)
  (nested; `isolation: worktree`).
- Windows URI handlers present (`HKCU\Software\Classes`): `vscode` (Code.exe `--open-url`) and
  `claude-cli` (claude.exe `--handle-uri`). None for `agent-host-session`, so those links open only
  inside VS Code.

## Experiments (real, this machine)

A disposable repository `repo-a` (one commit, `factory.json` committed) with a hand-made linked
worktree `wt-proof` on branch `proof-branch`, both under `%TEMP%\orch-phase3-demo`. Each child was
asked to write the output of `git rev-parse --show-toplevel`, `git branch --show-current`, and
`pwd` into a file and stop. The initiating checkout (this ORCH worktree) was clean before and after.

| #   | `create_session` arguments                                   | Where the child ran                          | Result                                                                                                                                                                                            |
| --- | ------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `workspace: <wt-proof path>`, `worktree: false`, independent | `repo-a` (project root, branch `main`)       | Session created and visible (`agent-host-session://ahp-session/17b6e18f-…`), but the worktree path was collapsed to its project; the file landed in the primary checkout                          |
| A   | `workspace: <repo-a path>`, `worktree: true`, independent    | `repo-a.worktrees/<slug>` on `agents/<slug>` | Session created and visible (`…/d6e49339-…`); host made the worktree from the current HEAD; the file landed in it; `list_sessions` reports `workingDirectory`, `project`, `git.branch`, `changes` |
| B   | `workspace: file:///…/wt-proof`, `worktree: false`           | `repo-a` (project root)                      | Same as 1: a `file://` URI does not select the worktree either                                                                                                                                    |

Observed about the host-made worktree: it lives at `<repo>.worktrees/<slug>` beside the
repository, the slug comes from the prompt's first words (`title` is not used), a second session
with the same prompt prefix gets the slug suffixed with the session id prefix, and the branch is
`agents/<slug>` from the repository's current HEAD. No confirmation prompt was shown to the parent
for any `create_session` call.

`claude agents --json` listed each child as an `interactive` session with a Claude session UUID
and the host-made worktree as `cwd`, so the Agents-window session is backed by an ordinary Claude
Code conversation (`claude --resume <uuid>` applies), but the parent never learns that UUID from
the host tools; only the `agent-host-session://` link is returned.

## Capability verdicts

| Operation                           | Verdict   | How                                                                                        |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| Create an independent session       | Supported | `create_session` with `relationship: independent`                                          |
| Specify the harness or provider     | Partial   | `model` selects the new session's provider; this session's harness (Claude) was inherited  |
| Specify the working directory       | Partial   | A project folder; an arbitrary directory inside a repository is mapped to the project root |
| Select a worktree                   | Partial   | Only a new worktree the host creates (`worktree: true`); an existing one cannot be chosen  |
| Supply an initial prompt            | Supported | `prompt`; it is sent, not merely pre-filled                                                |
| Return a stable session identifier  | Supported | `agent-host-session://ahp-session/<uuid>` link; also `session` URI in `list_sessions`      |
| Query session state                 | Supported | `list_sessions` (`idle`, `inProgress`, `inputNeeded`, `error`, `archived`; cwd, git)       |
| Navigate to the session in VS Code  | Partial   | The link is clickable in VS Code chat and the Agents window lists it; no OS handler        |
| Resume an interrupted session       | Partial   | `send_message` to an idle session; a stopped session is re-opened from the Agents window   |
| Start several sessions concurrently | Supported | Two `create_session` calls in one turn created two sessions that ran at the same time      |

## The flow this leads to

Because the host cannot be pointed at a worktree ORCH created, but reliably creates one of its own,
`orch factory dispatch` creates only the job, the skill asks the host for an independent session on
the repository with `worktree: true` and the prompt `/factory <id>`, and the child's
`orch factory resume <id> --adopt <toplevel>` records the host-made worktree as the job's. Second
demonstration, with the Phase 3 build and `ORCH_HOME=E:\github2\orch-phase3-state`: two jobs
dispatched for `repo-a` from this session (`job-71e79782`, `job-47d382cc`; a third dispatch for the
same issue returned the first job with `duplicate: true`), two `create_session` calls, and each
child ran only `orch factory resume --adopt` and `orch job session attach`. `orch factory list`
afterwards showed each job owned by its own child session (`phase3-child-one`, `phase3-child-two`,
leases live), each with the host-made worktree (`repo-a.worktrees/phase-3-capability-…` and
`…-fb0d731f`) on its `agents/…` branch, and each with its own `vscode-agents` session attached;
`git status` in `repo-a` was clean. The factory stages were not run (deliberately: B05 waits for
Phases 1 and 2).

## Limitations

- Not automated: a child session still depends on the human-visible permission level of the
  Agents window for its tool calls; the parent cannot grant it anything.
- The `title` given to `create_session` names the session but not the worktree; the worktree slug
  comes from the prompt, which is why the dispatch prompt starts with `/factory <id>`.
- `agent-host-session://` links cannot be opened from a browser; the dashboard copies them.
- Outside VS Code's Agents window (a terminal session, the extension panel) `create_session` does
  not exist; the printed fallbacks (`claude --worktree <id> "/factory <id>"`, `code --agents`) are
  commands for a human, not launched sessions.
- `send_message` to steer a child was not exercised; VS Code documents that sending always asks
  for confirmation.
