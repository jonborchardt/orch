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
worktree, review round, reviews, elapsed time, last update, PR link and CI rollup. When the rows
shown come from more than one repository, the caption under each title adds a short repository
label after the id (the identity's last segment, or a longer trailing path such as `acme/alpha`
when two repositories share a basename; hovering it shows the full identity), whether or not the
Repository column is shown; narrowing the board to one repository drops it. The Reviews
column is one rollup chip for the current round: `n/n pass` (green) when every reviewer passed,
`p/n, k pending` (neutral) while some are pending and none requested changes, `c changes` (amber)
when any did, and nothing before the round has reviews; hovering or focusing it lists each reviewer
and its verdict. Beside it, `n blocking` (red) shows the blocking-finding count from the current
round's consolidation when it is above zero; there is no separate Blocking column. Both are
current-round only: while a new round is open, earlier rounds' verdicts and blocking counts are
not shown on the board (they stay in the detail view's Reviews and Findings tabs). The Round column
reads `-` before the first review round and `N / M` from round 1 on (round N of at most M); its
tooltip says so in words ("Review round 2 of at most 3", "No review round yet (at most 3)"), and
the same words are the text assistive technology reads.

The Stage column is the workflow position, shown as a **progress strip**: eight steps in order,
Spec, Build, Simplify, Review, Approve, PR, CI, Done, each drawn with a glyph for its state (`✓` done, `▶`
current, `■` stopped, `○` not started; colour, from the active light or dark scheme, is only a
second cue), followed by a short label such
as `Build`, `CI, needs human`, `Build, interrupted`, `Review, cancelled`, or `Done`. The strip is in
the Tab order; hovering or focusing it lists every step with its state, and its accessible name
states all eight. The model is computed on the server (`progressOf` in `src/server/status.ts`) from
the job row and the newest `job.blocked` event the board already loads, and shipped on each row as
`progress`. Exactly one step is current or stopped; steps before it are done and steps after it are
not started, even when an earlier pass reached them (a job reworked from CI back to Build shows
Spec done, Build current, the rest not started). A pending or running job (including a stale one)
is current at its stage; an interrupted, failed, or cancelled job is stopped at its stage; an
escalated job (`needs-human`, never itself a step) is stopped at the `from` stage of its newest
`job.blocked` event, else at its `returnStage`, so a CI escalation after the repair budget is spent
reads `CI, needs human` though it would return to build; when neither names a delivery stage no
step is marked and the label is `Needs human`. A completed job has all eight done; a cancelled job
never shows Done. Sorting the column orders by that workflow position. The status column is the
execution state, kept separate so a job stopped in
`build` never reads as done. Its states (each with a glyph and label, never colour alone):
`running` means the status is `running` and a session renewed its lease recently (a live lease, not
proof that a process is alive now); `stale` means the status is still `running` but the lease lapsed
without renewal, so the session may no longer be working or may only have missed a renewal;
`interrupted`, `failed`, `needs human`, `idle` (pending), `completed`, and `cancelled`, which is grey
and never styled like a success. A lapsed lease never reads as `running`; each chip's tooltip, and
the detail view, carries the full meaning of its state. Under the chip, one line says why a stopped job stopped, derived from
persisted fields only (`src/server/status.ts`): the latest `job.blocked`, `stage.failed`,
`job.interrupted`, or `job.cancelled` event and its recorded reason, the `decision.md` marker, the
consolidation's BLOCKING count, and the newest verification run. When the state does not classify an
escalation the line says so (`Escalated from build`) rather than guessing. The line wraps to two
lines before its ellipsis and is dotted-underlined; hovering or focusing it (it is in the Tab order)
shows the full text, prefixed with the blocker label, in a tooltip. Jobs a session may resume
get a **Copy resume** control. Filter by repository and by **Show**: `current` (the default, every
unarchived job), `active`, `needs human`, `running`, `stale`, `failed` (failed or interrupted),
`idle`, `finished`, `cancelled`, or `archived`, each labelled with its count; plus a free-text
**Filter** box matching title, id, repository, stage, status, session, or branch. The app bar's
summary chips (`n running`, `n stale`, `n need human`, `n failed`, `n idle`) are toggle buttons for
the matching Show option and carry its count; pressing the pressed chip again returns to `current`.
Counts are taken from the selected repository's jobs, before the text filter, and are left off until
the first response arrives. The page refreshes every few seconds while visible. The first load of
the board or a job's detail shows a progress bar; after that a thin `Refreshing` bar in a fixed slot
under the app bar shows while a poll is in flight. Archived jobs (see **Archive** below) are left
out of every filter except `archived`, which shows only them, each marked with an `archived` chip.

The board is a plain MUI table (`web/src/JobBoard.tsx`, no data-grid package). Clicking a row, or
focusing it and pressing Enter, opens the job; the buttons, links, and chips inside a row act on
their own and never open it. Clicking a header
sorts by that column, ascending then descending (`aria-sort` says which; Reviews sorts by blocking
count). With no sort chosen the board orders by attention, in the client: needs human, last reported
running (stale), failed or interrupted, running, idle, then completed and cancelled, most recently
updated first within each group; `GET /api/jobs` keeps its own order (newest created first). The
**Columns** menu shows or hides every column except Job, Status, and Actions; Repository, Session,
and Branch / worktree start hidden. The choice is a per-browser view preference in `localStorage`
(`orch.board.hiddenColumns`), not job state. The Actions column holds **Archive** on each finished,
unarchived row and **Unarchive** on each archived row (so under Show: archived). Either opens a
plain Cancel / Archive (or Unarchive) confirm. Only finished jobs qualify; finishing releases a job,
but a session may have claimed it again (to observe CI), so the board always sends `force` to take
it over; the server decides as for any action, and the board reloads afterwards.
Nothing archives automatically.

**Job detail** (`#/jobs/<id>`): next step and agents from the plan, the request, and tabs for the
spec, build summary, review history per round (the job's current round is labelled
`Round N (current)`; one collapsed panel per reviewer whose header shows the reviewer, verdict,
and summary; expand it for the full review text), consolidated
findings per round, the approval decision, registered artifacts (size, marker, hash), the event
log, Git state (branch, HEAD, ahead/behind base, commits, changed files, uncommitted files), and
the PR with its CI state. Buttons open the worktree in VS Code (`vscode://file/...`) and the PR on
GitHub. The header carries the same progress strip as the board (in place of a raw stage chip)
and the round as `Round: none` or `Round N / M`, with the same tooltip. The Overview tab ends with a
**Progress** section: every step in order with the same state as the strip and the times the
timeline knows (`started …`, `completed …`, or `completed earlier …` for a step the current pass
has not redone), then the **Timeline**. Times read relatively (`5m ago`), with the exact timestamp
in the tooltip. The timeline is built by `timelineOf` in `src/server/status.ts` from
`stage.started`, `stage.completed` (with the review round and whether it requested changes),
`stage.failed`, `job.blocked`, `job.resumed`, `job.reworked`, `job.interrupted`, `job.cancelled`,
and `job.completed`, oldest first, each with its time and a plain label. Going back (changes
requested, rework from PR or CI, resume to an earlier stage) is a new entry, never an edit to an
earlier one. The detail loads the newest 500 events; when it reaches that cap the timeline says
"Earlier history not shown", and the step states, which never read the timeline, are unaffected.
A status panel above the controls reads as one summary line, one **Next:** line, and a
collapsed **Details** expander. The summary is the bold blocker label and one sentence: for a
`CI stopped` job the CI line (head and repair budget), otherwise the blocker summary with the
recorded reason, or the completion line or state description when nothing blocks. The next line
names what to do for that state: the CI guidance (also for completed jobs); for an approver
escalation, read the decision below and then Resume at the return stage or Request rework; for
exhausted review rounds, Request rework or cancel; for a failed verification, Request rework or
resume; for an unclassified escalation, no recommended control; for a failed, interrupted,
waiting, or lapsed job, resume from a Claude Code session in the checkout; while a session holds a
live lease or runs the job, continue from or wait for that session. A cancelled job has no next
line. When a session may resume the job, a **Copy resume command** button for
`/factory resume <id>` sits beside those two lines. Details holds the rest: a `CI stopped` job's
recorded reason, the command with the checkout to run it in (the repository the job was started
from, with an "open in VS Code" link) and the worktree, the note that copying changes nothing
(only a Claude Code session opened in that checkout resumes the job), the per-state note and the
equivalent CLI, and the execution session. While any session holds a live lease the command is
withheld and Details names the holder, because `orch factory resume` would be refused without a
deliberate `--force`; the dashboard never forces ownership. At `needs-human` a block between the
status panel and the controls shows the approver's `DECISION` marker with the `Rationale` section
of `decision.md` verbatim (or "No approver decision recorded."), and the newest consolidated
round's blocking findings: "Round N: K blocking finding(s)" with that round's `[BLOCKING]` lines.
The `BLOCKING:` marker is authoritative, so a round recorded as 0 says "no blocking findings" even
when tagged lines remain in the file.

**CI state** is shown with the commit it was read for, never on its own: the board's chip reads
`CI <rollup> @<sha7>` (plus `repairs n/m` once a repair happened) and the detail's PR tab carries
the full head, when it was observed, whether it is still the worktree HEAD (an old green verdict
for a commit that is no longer HEAD is marked as not current), GitHub's reason
from the last `orch gh ci` reconciliation, each failed required check with its GitHub log link and
the log saved under the artifact directory, and one line of guidance. The repair budget is stated
once, in the CI line (`n of m repairs used`) and the chip's `repairs n/m` caption; the detail's
status panel uses the CI line as its summary and the guidance as its next line. Everything comes from
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
server re-checks every request. `Resume at <stage>` (the `approve` action, labelled by the stage
it sends the job to) is the primary control only when the approver escalated (`decision.md` says
ESCALATE); for any other blocker it is demoted behind a warning, because resuming moves the job
without fixing anything. Request rework is primary only when reviewers
still requested changes at the last allowed round, which is where the workflow itself would go
back to `build`; for interruptions, verification failures, and unclassified escalations every
control stays neutral, since the right transition is a human call.

| Action                     | Allowed when                                                                                                                       | Effect                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Resume at <stage>`        | stage `needs-human`                                                                                                                | `resume --to <stage>` (default: where it came from)    |
| Request review round       | round ≥ 1, not finished                                                                                                            | `escalate` + `resume --to review` (opens a new round)  |
| Request rework             | not finished                                                                                                                       | `escalate` + `resume --to build`                       |
| Accept verification policy | worktree `factory.json` differs                                                                                                    | snapshot it as the job's policy (`jobs.policy`)        |
| Accept delivery            | `needs-human` from `ci`, PR head observed, and GitHub reported no checks at all or the PR was merged by hand; a reason is required | `resume --to completed`, recorded as a human close-out |
| Cancel job                 | not finished                                                                                                                       | `cancel`                                               |
| Archive                    | status `completed` or `cancelled`, not archived                                                                                    | sets `jobs.archivedAt`; event `job.archived`           |
| Unarchive                  | status `completed` or `cancelled`, archived                                                                                        | clears `jobs.archivedAt`; event `job.unarchived`       |
| Merge                      | completed on GitHub's verdict, `prState` `ready`, `ciStatus` `passing`, `ciHead` set                                               | `gh pr merge --merge --match-head-commit <ciHead>`     |
| Refresh PR                 | PR recorded and not merged; the job is finished or in `needs-human`                                                                | re-reads the PR; records `prState` (`pr.observed`)     |
| Remove worktree            | status `completed` or `cancelled`, `prState` `merged`, worktree recorded                                                           | `orch worktree remove`: refused if dirty; branch kept  |

Accept delivery is the only control that completes a job by hand. It is listed by the same rule the
transition applies (`cannotAcceptDelivery` in `src/core/workflow.ts`), so it never appears while
checks are pending or failing, it is never the primary control, and it refuses an empty reason; the
`job.completed` event carries `acceptedByHuman: true` and the reason, and the dashboard shows the
job as completed by human close-out rather than as a passing build. It does not merge or mark the
PR ready.

**Merge** is a plain Cancel / Merge confirm naming the PR and the short head SHA. The server reads
the PR from GitHub again and merges only if it is open, not a draft, its head is still `ciHead`,
and GitHub reports it `MERGEABLE`; otherwise it refuses and nothing is called. A merge GitHub
refuses (for example a repository that disallows merge commits) is recorded as `pr.merged` with
`ok: false` and gh's message, and `prState` stays `ready`. It never deletes the branch, bypasses
protection, or queues an auto-merge, and there is no CLI equivalent
(`docs/decisions/2026-11-15-humans-merge-from-the-dashboard.md`). **Refresh PR** re-reads the PR
and records only its state, never the CI verdict, stage, or status; a PR merged on GitHub by hand
shows as merged after it, and on a ci escalation that makes Accept delivery available. Nothing
polls GitHub: the board's periodic refresh re-reads the database only.

**PR phase.** The board's PR / CI column and the detail header show a chip (glyph and label) for
where the PR stands, from recorded fields only (`prPhase` in `src/core/workflow.ts`): `no PR`,
`draft` (CI not passing yet), `CI running`, `CI failing`, `ready to merge` (completed on GitHub's
verdict, marked ready, CI passing), `ready marking failed` (completed on the verdict but the PR is
still a draft: run `gh pr ready`, then Refresh PR), `merged`, and `closed`. `ready to merge` is
orch's record; GitHub's live mergeability is checked only when Merge is clicked.

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
