# Live Claude output from stream-json, durable record from the transcript

**Decision.** `launchClaude` starts the controller's child as
`claude -p <permission args> --name <name> --output-format stream-json --verbose --session-id <uuid> <prompt>`
with stdout and stderr piped. Each stdout line is parsed: the `system`/`init` line, every `text`
and `tool_use` block of an `assistant` turn (prefixed `agent` for a subagent's), and the final
`result` become one clipped line each, which `src/ops/run.ts` prints as `  claude: ...` through
the controller's log (stderr, so `orch do --json` stays JSON). A line that is not JSON is shown
as it is; an unknown type is skipped. Stderr is copied to the controller's stderr as it comes and
its last 4000 characters kept. Before the launch the controller generates the uuid and records it
on the job as a `claude-code` `session.attached` (with the runner's token), so the Session tab
reads that conversation's transcript from the first minute. The `runner.session` event gains
`sessionId`, `stderrTail`, and `result` (`subtype`, `isError`, `result` clipped to 1000
characters, `numTurns`). They are evidence: nothing decides from them, and stop, ownership,
budgets, and exit handling are unchanged.

**Findings (claude 2.1.323, Windows).** `--output-format` takes `text` (default; only the final
message), `json` (one object at the end), or `stream-json` (one object per line as it happens);
all need `-p`, and `stream-json` with `-p` fails without `--verbose`. Lines seen: `system`
(`hook_started`, `hook_response`, `init` with `session_id`, `cwd`, `model`), `assistant` (with
`message.content[]` of `text` / `tool_use` blocks, `parent_tool_use_id` set for subagents),
`user` (tool results), `rate_limit_event`, and a final `result` (`subtype`, `is_error`, `result`,
`num_turns`, `duration_ms`, `total_cost_usd`). `--include-partial-messages` adds token-level
chunks and `--include-hook-events` hook traffic: too noisy for a terminal, not used.
`--session-id <uuid>` fixes the conversation id, so its transcript is known before the child
starts. `--debug-file` is a separate unbounded log, not used.

**Why.** A ten-minute job used to show three controller lines, and a child that failed left
nothing behind. Claude Code already writes the full conversation to its transcript, and the
dashboard already reads transcripts of attached sessions; fixing the id up front ties the two
without a new log file, table, or path. The live lines and the bounded stderr tail cover what the
transcript does not: the terminal view and the process's own errors.

**Consequences.** With piped output the child's writes fail if the controller dies (it used to
inherit the terminal and run on); the existing refusal in `orch resume` while the child may be
alive stays. Both pipes are read for the child's whole life, and after it exits its last output
is waited for at most two seconds, so a grandchild holding a pipe cannot hang the controller.
`--output-format`, `--session-id`, and `--no-session-persistence` in a user's `runnerClaudeArgs`
are unsupported: orch passes its own after `--name`, and the last one would leave no transcript.
The `/factory` skill's own attach of `CLAUDE_CODE_SESSION_ID` stays; it is expected to equal the
passed id, and if it does not, the newer ref is shown.
