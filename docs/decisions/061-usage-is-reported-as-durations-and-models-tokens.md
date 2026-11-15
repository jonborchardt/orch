# 61. Usage is reported as durations and models; tokens are declared unmeasured

**What was looked for.** A per-job token and cost figure, through interfaces Claude Code supports.
The coordinating session launches subagents with the Agent tool; the tool result the model sees is
the subagent's final text only. The transcript on disk does carry `totalTokens`, `usage` (input,
output, cache creation, cache read), `totalDurationMs`, and `resolvedModel` per Agent call, but
the transcript format is internal and the assignment ruled out parsing it. `claude -p
--output-format json` reports usage and `total_cost_usd`, but the factory does not run subagents as
separate headless processes. The status-line input carries session cost, not per-agent cost, and
belongs to the user's configuration. OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY`) emits
per-request token and cost events with a session id, but it needs a collector endpoint and global
settings changes, and `orch ui` is not required for jobs to run. A `PostToolUse` hook on the Agent
tool receives the tool's structured response, which likely includes the usage block; hooks are a
supported mechanism, but the response shape is undocumented and installing a hook means editing
the user's `settings.json`, which `orch install` does not do.

**Decision.** `orch job usage <id>` reports only what the rows measure: stage visits with the
event that ended each, reviewer runs from the pending record to the verdict, verification run and
check durations, CI repairs, re-runs, and observations, and the model the configuration assigns to
each role (the model that actually ran is not recorded). `tokens.measured` is `false` with the
reason. No schema change, no estimate, no price table. If per-agent usage becomes reachable
through a documented path, the natural extension is a `usage` event per agent run carrying the
model and the four token counts, attributed to the job by its id in the agent prompt; the report
would then sum events instead of saying it cannot.
