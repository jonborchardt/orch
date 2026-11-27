# The controller waits out a usage limit, a rate limit, or an unreachable API, then continues

Ticket 0180. Supersedes the "waiting was left out" part of
[2026-11-24-usage-limit-ends-run-resumably](2026-11-24-usage-limit-ends-run-resumably.md).

**Decision.** When a headless `/factory` child ends on an exhausted main allowance (a limit that
names no model, a per-model limit whose pool has no unspent model left, or a session-reported
`models.limit` on a model without an allowance of its own), on a rate limit, or on an unreachable
or overloaded Claude API (`apiUnreachable` in `src/core/claude-limit.ts`: `ENOTFOUND`,
`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, "Can't reach the API server", an API 5xx, `overloaded`,
read from `stderrTail` or an error `result` only), `runJob` keeps the same ticket and job, waits
inside the controller's foreground command, and relaunches. `LIMIT_WAITS` in `src/ops/run.ts`:

- a usage limit whose epoch reset (`limitUntil`) is at most 12 hours away: until the reset plus
  60 seconds; for the pool cases, the earliest known `until` of the hits;
- a usage limit whose reset is further away (a weekly limit): no wait, the run stops at once;
- a usage limit without a parsed reset: a probe relaunch every 30 minutes;
- a rate limit or an unreachable API: 1, 2, 4, 8, then every 15 minutes.

One bound covers them all: 12 hours of waiting in a row. A launch that moves the job, or ends any
other way, resets it. Past the bound the run stops resumably, as before: `usage-limit` for a
limit, `api-unreachable` for an outage (both in `RUN_ENDING_CODES` and `RESUMABLE_CODES`). Such a
launch never counts toward `MAX_IDLE_LAUNCHES`, so an outage no longer passes tickets over one by
one as `no-progress`. A per-model limit that can fall back still falls back and never waits.

While it waits, the session file carries `wait: { reason, until }`, cleared when the wait ends;
`orch status`, `/api/runner` (`ControllerStatus.wait`), and the dashboard show "Waiting for ... at
<until>, then continue ticket <key>." The wait checks `orch stop`, `orch stop next`, and Ctrl+C
every poll and ends as `stopped`, leaving the ticket in flight and a `next` request in place for
`orch resume`. After a wait the loop starts over, so the stop, rebuilt-orch, and bad-config
checks run before any relaunch.

**Why.** An unattended overnight run used to end at the first limit, and an outage burned through
the queue as `no-progress`. Waiting where the run already is costs nothing a person must do. The
12-hour cap keeps a weekly limit or a long outage from holding the terminal for days; the stop
stays resumable. Text resets ("resets 3pm") are not parsed: their formats are unconfirmed, so they
probe instead. Like the bounded GitHub retry
([2026-11-25-bounded-github-retry](2026-11-25-bounded-github-retry.md)), this exists only while
the controller's command runs: no daemon, timer, detached process, table, or job event.
