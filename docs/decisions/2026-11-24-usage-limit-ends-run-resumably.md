# A Claude usage limit ends the run, resumably

**Decision.** When a headless `/factory` child exits and what it left (its `stderrTail`, or its
`result` text when the result is an error) matches a known Claude Code usage or rate limit
message (`claudeLimit` in `src/core/claude-limit.ts`), `runJob` returns `blocked` with code
`usage-limit` at once, before the exit counts toward `MAX_IDLE_LAUNCHES`. `usage-limit` is one of
`RUN_ENDING_CODES`. Unlike `claude-failed`, the session is left the way `orch stop` leaves it:
`finished` stays null and the ticket and job stay in flight, so `orch resume` continues the same
ticket and job. The summary reason names the limit and the reset time when Claude printed one;
the `runner.stopped` event's `next` is `orch resume`; the exit status is 1.

**Why.** A spent account fails every ticket the same way. Read as an idle session, it ended each
ticket `no-progress` and the queue went on, creating a job, a worktree and mail for every ready
ticket until the queue was empty (ticket 0130). Waiting until the reported reset time and
continuing was left out: the reset text comes in several unconfirmed formats (an epoch, or a
local time such as "3pm" with or without a zone), and waiting would make the foreground
controller sleep for hours. A form the detector misses falls back to the old behaviour.

A limit on a model with its own allowance (`fable`) is the exception: see
[2026-11-26-per-model-limit-falls-back](2026-11-26-per-model-limit-falls-back.md).

Waiting for the reset, and riding out an unreachable API, now happen in the controller: see
[2026-11-26-controller-waits-for-limits](2026-11-26-controller-waits-for-limits.md).
