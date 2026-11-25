# The controller rides out a transient GitHub failure with a bounded backoff

Ticket 0161. On 2026-11-25 a `gh pr merge` for ticket 0157 failed with "GraphQL: Something went
wrong while executing your query" while the PR was still OPEN and MERGEABLE at the verified head.
That came back as `github-refused`, a run-ending code, so an unattended `orch start` ended its
whole run on one hiccup of GitHub's.

The factory controller now retries a GitHub failure that looks transient, inside its own
foreground command, before it ends the run: after 1, 2, 4, 8, and 16 minutes
(`GITHUB_BACKOFF_SECONDS` in `src/ops/run.ts`), so at most six attempts at one step. It applies to
a `github-refused` merge whose message is transient, to a merge `error`, and to a transient
`ToolError` while it reads CI. Every retry calls `mergeJob` (or `reconcileCi`) again, so each one
reads GitHub fresh and passes every gate; nothing is assumed from the failure. Every wait goes
through the controller's `wait`, so `orch stop` or Ctrl+C ends it as `stopped`. When the budget
runs out the ticket ends with the same code and `next` text as before, and the reason gives the
attempt count.

This is a bounded retry of one step, not a poll, a timer, a queue, or a daemon: it exists only
while the controller's command runs, like its existing `RETRY_SECONDS` waits.

The decisions the user took:

- Q1, schedule: 1, 2, 4, 8, 16 minutes. A real outage of half an hour is ridden out; a longer one
  still ends the run with its reason.
- Q2, rate limits are refusals. `API rate limit exceeded` and `secondary rate limit` are not
  retried; waiting minutes against a limit that resets in an hour only hides it.
- Q3, only the controller retries. One-shot `orch job merge` and the dashboard's Merge report the
  failure at once, and a person repeats them; `src/ops/merge.ts`, `mergeDecision`, the gates, and
  `RUN_ENDING_CODES` are unchanged.

The call is the pure `transientGitHubError(message)` in `src/core/workflow.ts`, biased toward
refusal: only a 5xx, GraphQL's "Something went wrong", a timeout, or a network error is transient,
and a message that also matches a refusal (merge rules, protection, permissions, a moved head, not
mergeable, 401/403/404/422, rate limits) or matches nothing is a refusal. Classifying by gh's text
is brittle, so a misclassification may lose a retry but never retries a real refusal.
