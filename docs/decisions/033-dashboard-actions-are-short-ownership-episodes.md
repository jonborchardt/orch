# 33. Dashboard actions are short ownership episodes of session `dashboard`

`approve`, `request-review`, `request-rework`, and `cancel` (`src/ops/actions.ts`) claim the job as
session `dashboard`, run the same `transition` calls the CLI would (`resume --to`, `escalate` then
`resume --to`, `cancel`), and release the job. They refuse a job whose session holds a live lease
unless the user confirms a forced takeover; a job waiting in `needs-human` is the exception because
its session is, by the skill's rules, stopped. The response always states that no session is
running the job and gives the `orch factory resume` command: the dashboard records decisions, it
does not pretend to wake anything.
