# Dashboard (`orch ui`)

The optional local dashboard: what it shows, how its status is derived, its security model, and
how it is tested.

## Dashboard

`orch ui` is optional. Factory jobs never need it; it reads the same shared database and job
artifacts that the CLI writes and offers the few human decisions the workflow has.

```sh
orch ui                 # http://127.0.0.1:4777/ until Ctrl+C
orch ui --port 0 --open # free port, open the browser
ORCH_HOME=/tmp/demo npm run ui:seed && ORCH_HOME=/tmp/demo orch ui   # representative demo data
```

**Job board** (all repositories): repository, title and id, stage, status, session, branch and
worktree, review round, per-reviewer verdicts for the current round, blocking-finding count from
the latest consolidation, elapsed time, last update, PR link and CI rollup. The stage column is the
workflow position; the status column is the execution state, kept separate so a job stopped in
`build` never reads as done. Its states (each with a glyph and label, never colour alone):
`running (lease live)` means a session renewed its lease recently; `last reported running` means
the status is still `running` but the lease lapsed, so the session is presumed gone;
`interrupted`, `failed`, `needs human`, `idle` (pending), `completed`, and `cancelled`, which is
grey and never styled like a success. Under the chip, one line says why a stopped job stopped,
derived from persisted fields only (`src/server/status.ts`): the latest `job.blocked`,
`stage.failed`, `job.interrupted`, or `job.cancelled` event and its recorded reason, the
`decision.md` marker, the consolidation's BLOCKING count, and the newest verification run. When
the state does not classify an escalation the line says so (`Escalated from build`) rather than
guessing. Jobs a session may resume get a **Copy resume** control. Filter by repository and by
active / needs human / finished / cancelled / archived, plus a free-text **Filter** box matching
title, id, repository, stage, status, session, or branch; the page refreshes every few seconds
while visible. Archived jobs (see **Archive** below) are left out of every filter except
`archived`, which shows only them, each marked with an `archived` chip.

The board is a plain MUI table (`web/src/JobBoard.tsx`, no data-grid package). Clicking a header
sorts by that column, ascending then descending (`aria-sort` says which); with no sort chosen the
server's order stands. The **Columns** menu shows or hides every column except Job, Status, and
Actions; Repository, Session, and Branch / worktree start hidden. The choice is a per-browser view
preference in `localStorage` (`orch.board.hiddenColumns`), not job state. The Actions column holds
**Archive** on each finished, unarchived row and **Unarchive** on each archived row (so under
Show: archived). Either opens a plain Cancel / Archive (or Unarchive) confirm. Only finished jobs
qualify; finishing releases a job, but a session may have claimed it again (to observe CI), so the
board always sends `force` to take it over; the server decides as for any action, and the board
reloads afterwards.
Nothing archives automatically.

**Job detail** (`#/jobs/<id>`): next step and agents from the plan, the request, and tabs for the
spec, build summary, review history per round (one collapsed panel per reviewer whose header
shows the reviewer, verdict, and summary; expand it for the full review text), consolidated
findings per round, the approval decision, registered artifacts (size, marker, hash), the event
log, Git state (branch, HEAD, ahead/behind base, commits, changed files, uncommitted files), and
the PR with its CI state. Buttons open the worktree in VS Code (`vscode://file/...`) and the PR on
GitHub. A status panel above the controls repeats the board's explanation with the full recorded
reason and a **Resume** block. When no live lease is held (unowned, lapsed lease, interrupted,
failed, or released at `needs-human`) it shows the `/factory resume <id>` command with a copy
button, the checkout to run it in (the repository the job was started from, with an "open in VS
Code" link), and the note that copying changes nothing; only a Claude Code session opened in that
checkout resumes the job. While any session holds a live lease the command is withheld and the
holder is named, because `orch factory resume` would be refused without a deliberate `--force`;
the dashboard never forces ownership.

**CI state** is shown with the commit it was read for, never on its own: the board's chip reads
`CI <rollup> @<sha7>` (plus `repairs n/m` once a repair happened) and the detail's PR tab carries
the full head, when it was observed, whether it is still the worktree HEAD (an old green verdict
for a commit that is no longer HEAD is marked as not current), the repair budget, GitHub's reason
from the last `orch gh ci` reconciliation, each failed required check with its GitHub log link and
the log saved under the artifact directory, and one line of guidance. Everything comes from
persisted fields (`src/server/status.ts` `ciView`): the rollup columns, the newest `ci.observed`
event, and the `job.completed` event. A ci-stage escalation gets its own blocker (`CI stopped`)
naming the cause from the recorded reason code and outcome: repair budget spent, no checks for the
PR head, checks that never reached a verdict, a PR closed without merging, or a head that moved
outside the job. A completed job says how it completed: on GitHub's verdict, by a human close-out
(chip `human close-out`, with the reason in the events), or, for jobs older than the ci stage,
with no verdict recorded at all.

**Controls** reuse `src/ops/actions.ts`, which runs the same validated transitions as the CLI as a
short-lived `dashboard` session and then releases the job. The detail API lists the actions the
workflow allows in the current state (`allowedActions`) and the client renders only those; the
server re-checks every request. Approve is the primary control only when the approver escalated
(`decision.md` says ESCALATE); for any other blocker it is demoted behind a warning, because
approving moves the job without fixing anything. Request rework is primary only when reviewers
still requested changes at the last allowed round, which is where the workflow itself would go
back to `build`; for interruptions, verification failures, and unclassified escalations every
control stays neutral, since the right transition is a human call.

| Action                     | Allowed when                                                                                                                       | Effect                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Approve                    | stage `needs-human`                                                                                                                | `resume --to <stage>` (default: where it came from)    |
| Request review round       | round ≥ 1, not finished                                                                                                            | `escalate` + `resume --to review`                      |
| Request rework             | not finished                                                                                                                       | `escalate` + `resume --to build`                       |
| Accept verification policy | worktree `factory.json` differs                                                                                                    | snapshot it as the job's policy (`jobs.policy`)        |
| Accept delivery            | `needs-human` from `ci`, PR head observed, and GitHub reported no checks at all or the PR was merged by hand; a reason is required | `resume --to completed`, recorded as a human close-out |
| Cancel job                 | not finished                                                                                                                       | `cancel`                                               |
| Archive                    | status `completed` or `cancelled`, not archived                                                                                    | sets `jobs.archivedAt`; event `job.archived`           |
| Unarchive                  | status `completed` or `cancelled`, archived                                                                                        | clears `jobs.archivedAt`; event `job.unarchived`       |

Accept delivery is the only control that completes a job by hand. It is listed by the same rule the
transition applies (`cannotAcceptDelivery` in `src/core/workflow.ts`), so it never appears while
checks are pending or failing, it is never the primary control, and it refuses an empty reason; the
`job.completed` event carries `acceptedByHuman: true` and the reason, and the dashboard shows the
job as completed by human close-out rather than as a passing build. It does not merge or mark the
PR ready.

**Archive** hides a finished job from the board's default views and nothing else: stage, status,
`completedAt`, the PR and CI columns, the worktree, the branch, and the artifacts stay as they are,
and `/api/jobs` still returns the row (with `archivedAt`). It is a column, so it is the same in
every browser and survives a reload. Only completed or cancelled jobs qualify, so a live, blocked,
interrupted, or failed job can never be hidden; the detail page of an archived job shows an
`archived` chip and offers **Unarchive**. Neither action returns a resume command.

A job whose session holds a live lease (and is not waiting in `needs-human`) is refused unless the
user confirms a forced takeover, which rotates the token. Every action records a reason in the
events and answers with the fact that no session is running the job plus the exact
`orch factory resume` command; the dashboard never pretends to wake a Claude session.

**Security.** The server binds `127.0.0.1` only, checks the `Host` header against its own
loopback origins (DNS rebinding), rejects cross-site `Sec-Fetch-Site`, and for state-changing
requests requires a same-origin `Origin`, `Content-Type: application/json`, and a per-process
CSRF token obtained from `/api/session` (which a foreign origin cannot read). Bodies are limited to
64 KB and validated field by field; unknown fields are rejected. Static files come only from
`web/dist`; artifact text is served only for files registered in the database (no arbitrary path
reads); job rows never include the owner token; there is no shell-execution endpoint. Responses
carry a CSP, `nosniff`, and `no-store`.

**Development.** `npm run web:dev` starts Vite with hot reload on `127.0.0.1:5173`, proxying
`/api` to a running `orch ui`. `npm run build` compiles both the CLI and `web/dist`.
`npm run test:e2e` runs the Playwright suite against a seeded scratch database (first time:
`npx playwright install chromium`). Each run seeds its own `mkdtemp` home, starts `orch ui` on a
free port, and hands the URL and seeded ids to the workers through a state file under that home,
so two runs on one machine never share a port, a database, or a state file. `ORCH_E2E_PORT` pins
the port (a busy port is reported, never silently replaced by another server) and
`ORCH_E2E_KEEP=1` leaves the scratch home in place for inspection.
