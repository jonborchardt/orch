# `/factory dispatch`'s parallel session launch is retired

Ticket 0159, decided by the user on 2026-11-25 (option C). This supersedes the launch part of
[decision 051](051-dispatch-prepares-a-job-the-harness-starts-the.md): the skill no longer starts
an independent session per job, and `orch factory dispatch` no longer returns a `launch` block
(workspace, prompt, fallback commands).

**What is removed.** The skill's `dispatch <targets>` argument and step 2b (calling the host's
`create_session` tool, recording the child, printing a fallback command); the `Launch` type,
`launchFor`, and `DispatchResult.launch` in `src/ops/dispatch.ts`. The dashboard's re-land message
and the recovery report's `resume` hint say `/factory <id>` and no longer print
`claude --worktree` or `code --agents`.

**What stays.**

- `dispatchJob` and `orch factory dispatch`: create a job without claiming it (readiness, base
  check, duplicate by repository and issue, ticket claim). The controller (`src/ops/run.ts`) and
  the re-land (`src/ops/merge.ts`) use it.
- `adoptWorktree`, `orch factory resume --adopt`, and `orch worktree adopt`.
- The read side of `vscode-agents` sessions: the provider, `sessionLinks`, the skill's
  `get_current_session` attach, and the dashboard rendering of old jobs.
- The token-less `orch job session attach` for an unowned job.
- A person running several interactive `/factory <job>` sessions by hand, each in its own
  worktree.

**What to do instead.** `orch start` or `orch do <ticket>` for unattended work, one ticket at a
time; `/factory <job>` in one interactive session otherwise. Only the foreground controller starts
a Claude process, through `launchClaude`
([2026-11-21-foreground-factory-runner](2026-11-21-foreground-factory-runner.md)).

**Why.**

- Nobody used it: `session.attached` events with provider `vscode-agents` exist only on 2026-11-16
  (6 of them) and `worktree.adopted` 4 times in total; every attach since 2026-11-21 (82) is
  `claude-code`, the controller or an interactive `/factory <job>`.
- It contradicts the non-goals "Parallel throughput" and "Live steering"
  ([2026-11-24-positioning-and-non-goals](2026-11-24-positioning-and-non-goals.md)). The
  controller already refuses to run two tickets at once; dispatch was the remaining way the skill
  fanned out.
- Parallel factory suites cost real runs: two escalations were "verification blocked by machine
  load from parallel factory suites".

Options considered: A, keep it as a manual convenience (docs only); B, document it as outside the
main path; C, retire the launch (chosen). `docs/session-launch.md` is kept, marked superseded,
because earlier decisions cite its evidence. Running more than one ticket at once by other means is
a separate ticket.
