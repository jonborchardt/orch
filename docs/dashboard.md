# Dashboard (`orch ui`)

The optional local dashboard: what it shows, how its status is derived, its security model, and
how it is tested. The dashboard manages and observes work; the CLI and Claude Code sessions remain
where work is executed. It has no controller start, stop, or resume control and no chat with an
agent. Operating the factory: [operations.md](operations.md).

## Dashboard

`orch ui` is optional. Factory jobs never need it; it reads the same shared database and job
artifacts that the CLI writes and offers the few human decisions the workflow has.

```sh
orch ui                 # http://127.0.0.1:4777/ until Ctrl+C
orch ui --port 0 --open # free port, open the browser
ORCH_HOME=/tmp/demo npm run ui:seed && ORCH_HOME=/tmp/demo orch ui   # representative demo data
```

`orch ui` serves in the foreground until Ctrl+C, SIGINT, or SIGTERM, or until a parent that
started it with a piped stdin closes that pipe. A null or closed stdin is ignored, so a script, a
scheduled task, or a background shell can launch it (`orch ui --port 0 < /dev/null &`, or `< NUL`
on Windows) and it keeps serving; a pipe that closes at once (`echo | orch ui`) still stops it.

**Sections.** The app bar has five: **Jobs** (`#/`, and `#/jobs/<id>` for one job), **Tickets**
(`#/tickets`, and `#/tickets/<id>` for one ticket), **Runs** (`#/runs`), **Agents** (`#/agents`),
and **Usage** (`#/usage`). Each is a link, so every view can be opened, reloaded, and bookmarked by
its URL. The job counts, the job filters, and the board's error alert show only in Jobs; a section
polls only what it shows, so the ticket queue is not read while Jobs is open and the job board
rests while any other section is. Usage does not poll its own data: it loads on open, on a range
change, and from its Refresh button; the shared header's runner poll still runs there, as on every
section. A further section is one entry in `SECTIONS` in `web/src/App.tsx` and one branch
where the page body is chosen.

**Shared header.** Under the app bar, on every section, `App` renders one **Factory status** box
(`web/src/FactoryStatus.tsx`) from one `usePolled(fetchRunner, refreshMs)`: what `orch status`
prints, from `GET /api/runner` (`runnerStatus`, read-only; the body is described under Tickets
below). It sits below the sticky app bar and scrolls with the page. A line reads `Updated <ago>`
(`Updated just now` under 5 s), measured from the last successful runner poll, in a `<time>` whose
`datetime` and `title` carry that exact time, and ages once a second while a poll is pending.
When the latest poll failed, a warning (a ⚠ glyph and text) gives the error, the last successful
update when there is one, and "retries every N s"; only the error and retry sentence are its
`role="status"` live region, so the ticking time is not re-announced every second. When no poll has answered for
more than three refresh intervals it reads `Not updating` with the last update time. Either
clears with the next good poll, and the last good content stays shown under it. Before the first
response nothing is shown. There is no control in the box and no Retry: the next poll is the
retry, and the controller is started, stopped, and resumed from the CLI only. The job detail page
has no plain Refresh button either; its own poll keeps it current.

**Installed build.** Under the Factory status box, on every section, a warning shows `build.message` from
`GET /api/runner` when the installed build is older than the install checkout or its upstream
("built from X, main is at Y: pull, `npm run build`, `orch install`"; `installBuild` in
`src/ops/install-build.ts`, reading the stamp `npm run build` writes to `dist/build-info.json`).
While a controller runs, the advice says to run `orch stop next` first (`buildForStatus` in
`src/ops/run.ts`), since rebuilding mid-run halts it. It comes from the shared header's runner
poll, every refresh interval. Local refs only, nothing is fetched; no stamp, or a
failed request, shows nothing.

**Runs** (`GET /api/runs`, `runs` in `src/server/api.ts`) aggregates every job in every repository,
archived ones included, from rows already stored; nothing is estimated, and a value that cannot be
measured is null and reads "Unavailable". `total` is every job; `completed` and `cancelled` count
those statuses; `active` counts `pending`, `running`, `blocked`, `interrupted`, and `failed`.
`completionRate` is completed / (completed + cancelled). Average and median duration cover
completed jobs only, from `createdAt` to the finish the board's Elapsed uses (`completedAt`, else
the newest `job.completed` or `job.cancelled` event); completed jobs with no known finish are
counted in `durationUnknown`. `completedPerHour` is completed jobs divided by the hours from the
earliest `createdAt` of any job to the latest finish of a completed job, over the whole history.

**Agents** (`GET /api/agents`, `agents` in `src/server/api.ts`) shows two tables, Reviewers and
Stages; every role in `ROLES` (`src/core/roles.ts`) is in exactly one, in `ROLES` order. Only
finished runs count, so in every row Runs is the sum of its outcome columns. Average and Median
take measured runs only (a duration above zero); a caption under a table names the roles with runs
without a duration and how many. **Reviewers** (Role, Runs, Pass, Changes with its share of Runs,
Average, Median) has every `review` role, one run per `reviews` row with a verdict, timed
`completedAt - createdAt`, plus `spec-challenger`, one run per registered `spec-review-N.md`
artifact (`SPEC_REVIEW_PATH` in `src/core/artifact-rules.ts`) whose `VERDICT` marker gives Pass or
Changes; it has no start time, so its durations read Unavailable. **Stages** (Role, Runs,
Completed, Failed, Escalated, Sent back, Cancelled, Interrupted, Average, Median) has
`spec-writer`, `builder` (full jobs), `fast-builder` (fast jobs), `simplifier`, and `approver`, one
run per `stage.started` of their stage paired with its end by the same rule as `orch job usage`;
the end `stage.completed`, `stage.failed`, `job.blocked`, `job.reworked`, `job.cancelled`, or
`job.interrupted` picks the column. Stage time includes coordinator work.

Below them the Agents tab compares models within each role (`byModel` and `notes`, decision
[2026-11-25-attributed-findings](decisions/2026-11-25-attributed-findings.md)); rows are keyed by
role, model (`not recorded` for a job without a `models.drawn` event), whether the model matched
its author's, and `fellBack`. The model is the one the role ran: its draw, or after a
`models.fallback` event the fallback (decision
[2026-11-26-per-model-limit-falls-back](decisions/2026-11-26-per-model-limit-falls-back.md)); rows
from a job with such an event are separate and their Model cell ends "(fell back)", so they can be
left out of a comparison. **Reviewers by model** counts reviews, objections (CHANGES) and their rate, rounds
where the reviewer was the only objector, and its attributed blocking findings: real catches
(fixed, and it passed the next round), fixed but changes again, unresolved (fixed, no next-round
verdict), false alarms (declined, overruled by an APPROVE, vanished), and escapes (it passed, then a
CI repair, a bug ticket naming the job or its PR, or a revert ticket did), with the median review
time. Captions say open findings and unattributed rounds are left out, that a revert counts only
through a ticket, and that tokens per review are not measured. **Spec challenger by model** and
**Same or different model as the author** give reviews and objections. **Builders by model**
(builder, fast-builder, spec-writer by the job's draw) gives jobs, first-pass verification, mean
review rounds, CI repairs, escalations, and whole-job tokens per job over jobs with recorded
sessions (Unavailable when none has). **Notes** come from `src/core/model-notes.ts`: counts only
below 20 reviews or jobs, else a two-proportion z-test (|z| >= 1.96 states the direction) or a token
ratio, each with its n and a confidence label (low < 50, medium < 200, high). Nothing acts on them.

**Usage** (`GET /api/usage?hours=<24|168|720>`, `tokenUsage` in `src/server/api.ts`, read model
in `src/server/token-usage.ts`) charts token use per UTC hour (labelled in local time) over the last
24 hours, 7 days, or 30 days, the current partial hour included; any other `hours` is a 400. It
reads the Claude Code transcripts of every job, archived included, with a claude-code
`session.attached` UUID: every such session, its main `<ref>.jsonl` and its
`subagents/agent-<id>.jsonl` files, found by `discoverSession` in `src/server/transcript.ts` (shared
with the Session tab) and read whole through `readConfined` only. Each assistant record's `usage`
gives four counts kept apart: input, output, cache read, cache creation. Sidechain records count in
subagent files and are skipped in the main file, as the Session tab does. Records are deduplicated
by `message.id` over one fixed order (jobs by id, sessions oldest attach first, main file then
subagent files by name, lines in order); the last line for an id is counted, in its job and hour. A
job's span runs from its first claude-code attach to now, or to `max(updatedAt, completedAt)` once
completed or cancelled. A job whose span misses the range is not read and not listed; a file last
modified before the range starts is not read and is not a gap. A main transcript not found or
refused, a refused `subagents/` directory or file, a file over `USAGE_FILE_BYTES`, past the
request's `USAGE_TOTAL_BYTES`, or beyond `USAGE_SUBAGENT_FILES`, makes the job _missing_: every
bucket overlapping its span lists the job id in `missing` and is drawn hatched and outlined with
its text label ("missing data for ..."), never as a plain zero; the job's row carries the reason
and the total's `complete` is false. The page shows the total per kind and overall, a stacked
bar chart (SVG, no chart library), and a per-job table linking each job. The client adds a cost
weight in plain-input-token equivalents, `input x 1 + cache creation x 1.25 + cache read x 0.1 +
output x 5` (`WEIGHTS` in `web/src/Usage.tsx`; approximate API price ratios, not a bill), shown
whole beside the counts in the total and per job. The chart plots weight per hour, each kind at
its weighted share, with a weight axis, local-time ticks, gridlines, and a readout of the hour's
weight and four counts on hover or keyboard focus. Sessions already
recorded in the `token_usage` table (one row per session ref, counts per UTC hour; decision
2026-11-24-recorded-token-usage) are summed from the database by their own hours and never read or
flagged; only unrecorded sessions are read live as above, and a stored job with no
`session.attached` (backfilled) is listed in any range holding one of its stored hours. A session is
recorded once, from all its files read in full: when the controller's child exits, when this view
reads a session of a completed or cancelled job live (the only write a GET makes; a failure is
ignored), and by `orch usage backfill`, which matches a transcript to a job only when its first
`cwd` is the job's worktree path and reports what it could not match. A session with any file
missing, refused, or over a cap is not recorded and stays live-read. Decision
2026-11-24-dashboard-token-usage-from-transcripts, partly superseded by
2026-11-24-recorded-token-usage.

**Health** (`GET /api/health?hours=<24|168|720>`, `health` in `src/server/health.ts`) is the same
UTC-hour buckets as Usage for a later chart; no view shows it yet. It returns `series` (id, label,
group, unit) and, per bucket and in `total`, one value per series, all derived from events and rows
already recorded, archived jobs included: **errors** (stage failures and escalations by stage,
escalations by reason, failed verification runs, failing CI, CI repairs, refused merges, and one
`stop.<code>` series per controller stop code seen in the range), **reviewers** (finished reviews
and CHANGES per reviewer, spec challenges, sent-back counts, median review rounds of finished
jobs), and **throughput** (verified ticket merges, completed jobs and their median duration, ended
CI waits and their median). A count is 0 in an empty hour; a median counts in the hour its span
ended, is `null` with no spans, and its total is the median over the whole range. Any other
`hours` is a 400. It writes nothing, and nothing decides from it.

**Job board** (all repositories): repository, title and id, stage, status, session, branch and
worktree, review round, reviews, elapsed time, start time, last update, PR link and CI rollup.
The PR link reads `#<n>` (or `PR` when the URL has no `/pull/<n>`), with the PR phase chip beside
it saying where the PR stands; a row without a PR shows `—`.
Started is the local date and time of the job's first stage start (`jobs.startedAt`, stamped once
by the first `start` transition, not at creation; `—` before then or for jobs older than the
column), and unstarted jobs sort after started ones when ascending. Elapsed is
wall-clock time from job creation until it completed or was cancelled (until now while active),
blocked and waiting time included; a finished job's value stops at its terminal transition
(`completedAt`, else its newest `job.completed` / `job.cancelled` event) and shows `Unknown` when
neither is recorded, and a span under a second shows `<1s`. When the rows
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
and never styled like a success. A completed job's label says how it ended, from recorded fields
only (`outcomeOf` in `src/server/status.ts`, in this order): `completed: merged` when the recorded
`prState` is `merged` (orch's record, updated by Merge or Refresh PR, not GitHub's live state);
`completed: PR ready, checks passed` when it completed on GitHub's verdict and the PR is ready with
CI still passing; `completed: human close-out`; otherwise plain `completed` (a legacy job, a draft or
closed PR, or CI observed failing after completion), never a guess. Workflow completion is not a
merge: only the first label says the PR was merged. A lapsed lease never reads as `running`; each chip's tooltip, and
the detail view, carries the full meaning of its state. Under the chip, one line says why a stopped job stopped, derived from
persisted fields only (`src/server/status.ts`): the latest `job.blocked`, `stage.failed`,
`job.interrupted`, or `job.cancelled` event and its recorded reason, the `decision.md` marker, the
consolidation's BLOCKING count, and the newest verification run. When the state does not classify an
escalation the line says so (`Escalated from build`) rather than guessing. The line wraps to two
lines before its ellipsis and is dotted-underlined; hovering or focusing it (it is in the Tab order)
shows the full text, prefixed with the blocker label, in a tooltip. Jobs a session may resume
get a **Copy resume** control. A live job whose verification recently failed in a way that looks
flaky (`flake` on the row, from the newest `verification.flaky` event; see `docs/workflow.md`)
shows a **Likely flaky test** line naming the test, on the board and in the detail's status panel.
It is history, not state: it names its run and head, never blocks, and is hidden once the job
finishes or a newer run passes. When other live jobs fail the same test (`flake.sharedWith`), the
line reads **Likely machine-wide flaky test (also failing in ...)**, naming them. Filter by repository and by **Show**: `current` (the default, every
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
The Filter, Repository, and Show controls appear only on the board (`#/`), wrapping together as one
group; a job's detail page has no board to filter, so they are not rendered there, and their values
are kept for the return to the board. The summary chips stay on every page.

The board is a plain MUI table (`web/src/JobBoard.tsx`, no data-grid package). Clicking a row, or
focusing it and pressing Enter, opens the job; the buttons, links, and chips inside a row act on
their own and never open it. Clicking a header
sorts by that column, ascending then descending (`aria-sort` says which; Reviews sorts by blocking
count). With no sort chosen the board orders by attention, in the client: needs human, last reported
running (stale), failed or interrupted, running, idle, then completed and cancelled, most recently
updated first within each group; `GET /api/jobs` keeps its own order (newest created first). The
**Columns** menu shows or hides every column except Job, Status, and Actions; Repository, Session,
and Branch / worktree start hidden. The choice is a per-browser view preference in `localStorage`
(`orch.board.hiddenColumns`), not job state. On a narrow display the board also hides columns by
width, in CSS on top of that choice (a column the menu hides stays hidden; one it shows may still
be hidden by width, and the menu does not say so): below 1024px it hides Repository, Session,
Branch / worktree, Elapsed, Started, Updated, Round, and Reviews, and below 900px also Stage. Job, Status,
PR / CI, and Actions are never hidden by width; the Status cell wraps, and below 1024px the PR /
CI cell wraps too and Job narrows, so they and every Archive, Copy resume, and PR control stay on screen at 800px.
The table still scrolls sideways if real content is wider. The Actions column holds **Archive** on each finished,
unarchived row and **Unarchive** on each archived row (so under Show: archived). Either opens a
plain Cancel / Archive (or Unarchive) confirm. Only finished jobs qualify; finishing releases a job,
but a session may have claimed it again (to observe CI), so the board always sends `force` to take
it over; the server decides as for any action, and the board reloads afterwards.
Nothing archives automatically.

**Job detail** (`#/jobs/<id>`) has twelve tabs, in this order (`TABS` in `web/src/tabs.ts`):
Overview, Spec, Build, Reviews, Findings, Decision, Artifacts, Events, Session (the Claude Code
transcripts), Git, Verification, and PR. It shows the next step and agents from the plan, the request, and tabs for the
spec, build summary, review history per round (the job's current round is labelled
`Round N (current)`; one collapsed panel per reviewer whose header shows the reviewer, verdict,
and summary; expand it for the full review text), consolidated
findings per round, the approval decision, registered artifacts (size, marker, hash), the event
log, Git state (branch, HEAD, ahead/behind base, commits, changed files, uncommitted files; once
the PR is recorded merged, "Merged into `<base>`" with the PR link and merged head, the commits
and files from the merged head's recorded verification, and only commits made since the merge as
outstanding, never the current ahead/behind), and
the PR with its CI state. Buttons below the header open the worktree in VS Code
(`vscode://file/...`) and the PR on GitHub. The header is two lines. The first is the title, the
job id, the status chip, the same progress strip as the board (in place of a raw stage chip), and
the round as `Round: none` or `Round N / M` with the same tooltip (plus `archived` and
`refresh failed` when they apply). The second is delivery: the repository, the branch, the PR as
`PR #<n>` (or `PR` when the URL has no `/pull/<n>`), the PR phase chip (left out while it would
repeat the CI chip's `CI running` or `CI failing`), the compact CI chip when CI was observed or the
job was closed out, and `updated <ago>` with the exact time in its tooltip. A field without data is
left out, never shown as `—` or `none`, and long values wrap rather than clip. The branch tooltip
names the base (`into <base>`). The branch links to `<repo>/tree/<branch>` on GitHub (`links.branch`,
derived from a `github.com/<owner>/<name>` repository or the PR URL, with no network call) only once
it is known to be on the remote: a recorded PR or a `branch.pushed` event. Before that it is plain
text, with `not pushed yet` in its tooltip. The owner session and its lease (`lease until|lapsed
<ISO>`) are in the status chip's tooltip, and as an `Owner …` line in the status panel's Details
whenever an owner is recorded, live or lapsed. Details also always has a visible branch line,
`Branch <branch> into <base>` (with `, not pushed yet` when the header tooltip says so) or
`Base branch <base>` before a branch exists, so nothing in a header tooltip is reachable only by
hovering. The update time is a `<time datetime>` element. The Overview tab ends with a
**Progress** section: every step in order with the same state as the strip and the times the
timeline knows (`started …`, `completed …`, or `completed earlier …` for a step the current pass
has not redone), then the **Timeline**. Times read relatively (`5m ago`), with the local date and
time, zone included, in the tooltip (the `When` component; its `<time datetime>` keeps the ISO
value). The timeline is built by `timelineOf` in `src/server/status.ts` from
`stage.started`, `stage.completed` (with the review round and whether it requested changes),
`stage.failed`, `job.blocked`, `job.resumed`, `job.reworked`, `job.interrupted`, `job.cancelled`,
and `job.completed`, oldest first, each with its time and a plain label. Going back (changes
requested, rework from PR or CI, resume to an earlier stage) is a new entry, never an edit to an
earlier one. The detail loads the newest 500 events; when it reaches that cap the timeline says
"Earlier history not shown", and the step states, which never read the timeline, are unaffected.
The tab labels say what each tab holds, one meaning per count, and the count is part of the tab's
accessible name: `Reviews (N rounds)` counts review rounds (never reviews), `Findings (N
blocking)` is the newest consolidated round's validated `BLOCKING` marker (plain `Findings` when
that round has none), `Artifacts (N)` counts registered artifacts, and `Events (N)` counts the
events loaded (`Events (500+)` at the cap). A tab whose empty state is useful stays reachable and
says so in its label: `Reviews (0 rounds)`, `Findings (empty)` before any consolidation,
`Artifacts (0)`, `Events (0)`, `Git (empty)` without a worktree or merge, and `Verification
(empty)` without verification state; it is also set in italics. Spec, Build, Decision, and PR
cannot have content until `spec.md`, `build.md`, `decision.md`, or a PR URL or `pr.md` exists:
they are `aria-disabled`, and one line under the tab strip (`Not available yet: …`) gives each
one's reason, which is also the tab's accessible description. Activating one changes nothing,
and arrow keys skip it. The shown tab is the one last picked when it is available and Overview
otherwise, decided on every render, so a tab that becomes unavailable on a poll or another job
falls back to Overview and returns when it is available again. `web/src/tabs.ts` holds these
rules (`detailTabs`, `resolveTab`); deep links to tabs must use those two functions, never a rule
of their own.

The **Events** tab lists every loaded event, newest first, in a fixed-layout table that cannot
widen the page: Time (relative, with the local date and time and its zone in the tooltip), Type,
Actor (one line, cut with an ellipsis, the full value in its tooltip), and Summary. The summary is
one line built on the client by `eventSummary` in `web/src/format.ts` from the type and the fields
that type records, shown after the Type column without repeating the type: `passing @92e988a,
poll 5` for a `ci.observed`, the stage and round for `stage.*`, from, to and reason for `job.*`,
the run and status for `verification.completed`, `round 1, security: changes` for a review, the
path for an artifact, the state for `pr.*`, the branch and head for `branch.pushed`, the provider
and short ref for `session.attached`, the outcome and code for `runner.*`; any other type lists
its short scalar fields, and an event with nothing to summarise reads `payload`. The summary is
the handle of a collapsed expander (a native `<details>`) holding the raw payload as
pretty-printed JSON, which scrolls sideways inside its own cell. A **Type** select above the
table offers `All types` (the default, which hides nothing) and each type present with its count
(`stage.completed (4)`); choosing one shows only those rows. Nothing is dropped or merged: under
`All types` there is one row per loaded event.

The **Session** tab, after Events, shows what the job's Claude Code session and its subagents are
doing and have done, read directly from Claude Code's transcripts (decision
2026-11-20-session-tab-reads-transcripts; afk-viewer reads the same files but is not used). It is
labelled `Session (empty)`, in italics, while the job has no claude-code session attached, and is
never `aria-disabled`. **Tie rule:** a transcript belongs to a job only through a session UUID in
that job's own `session.attached` events with `provider: claude-code` (the `/factory` skill
records `$CLAUDE_CODE_SESSION_ID` after `start` or `resume`); the newest such attachment is read
even when a later `vscode-agents` attachment is the current session. The server
(`src/server/transcript.ts`, `GET /api/jobs/<id>/session-log`) finds `<uuid>.jsonl` one level
under `<claude home>/projects/` (`CLAUDE_CONFIG_DIR`, else `~/.claude`), taking the most recently
modified file when several directories hold it, and reads that session's subagents from the
`agent-<id>.jsonl` files (with their `agent-<id>.meta.json`) in `<that directory>/<uuid>/subagents/`.
Nothing else is read: no `cwd` or transcript-path matching, no query parameter or path suffix that
picks a file. Each file must resolve, by real path, inside the real `projects` directory (a
subagent file also inside its real `subagents/`) and be a regular file, so a junction or symlink
cannot lead out. That listing check only filters: each file is opened once, and the open handle
must then prove itself, a regular file whose path resolved after the open lies inside the same
root with the handle's device and inode (compared as bigints), before anything is read through
it; the open handle pins its inode, so a reused inode number cannot pass, and a path swapped
between the listing and the read is not followed. One race remains where the path is resolved by
name: a directory on the path swapped to a link out at the open, back to the real directory at
the path check, and out again at the identity check. It is closed on Linux, where the path checked
is the open handle's own (`/proc/self/fd/<fd>`), and remains on Windows and macOS, where Node has
no handle-to-path call; winning it needs write access to the user's own Claude projects directory,
whose owner can already read every transcript, so its impact is low. **Bounds** (exported
constants): each file is read only from its end, at most `TAIL_WINDOW_BYTES` (256 KB); at most
`TOTAL_READ_BYTES` (2 MB) per request, newest file first; the newest `MAX_SUBAGENT_FILES` (24)
subagent files, ordered by one `lstat` each and only those resolved, the rest counted;
`META_MAX_BYTES` (16 KB) per meta file, with its type and description cut at `META_TEXT_MAX` (200)
characters; `MAX_ENTRIES` (400) entries, `ENTRY_TEXT_MAX` (4000) characters each, and
`MAX_RESPONSE_BYTES` (1 MB) of JSON. Records become `user`, `assistant`, `tool` (the tool name and
its key input), `result`, and `error` entries; thinking blocks, attachments, queue operations,
snapshots, malformed lines, and sidechain records in the main file are skipped. The panel shows
the transcript's modified time and size; a Subagents list where each subagent is `finished` when
its meta file says so, `running` only when the meta file says `finished: false` and its transcript
changed in the last five minutes, `not finished` when the meta file says `finished: false` and the
transcript is older than that (for example a subagent inside one long tool call, such as a
verification run, which writes nothing until it returns), and `status unknown`, with a short
explanation, only when there is no meta file or it has no readable boolean `finished` field, each
with when it was last active; the merged timeline newest first (relative time with the local time and zone in a tooltip, and a
`main` or `<agent type>: <description>` label); "Earlier activity not shown" with the number of
entries shown when a file was cut or a cap was hit; and earlier claude-code sessions with their
`claude --resume <ref>` (not read). Long text collapses with Show more / Show less, a button with
`aria-expanded` whose accessible name also names its entry; content is plain text, never Markdown
or HTML. The tab refetches on the detail poll, only while it is shown. The empty states never ask
the reader to run a command (attaching needs the owning session's token): with no claude-code
session recorded, the tab says the job's session records itself when it starts or resumes through
`/factory` (naming the command it runs) and that jobs started before session logs have none; with
a session recorded but no transcript found, it names the session id and the directory searched,
and gives `claude --resume <ref>`; when a transcript has content but no record could be shown, it says
the file may be unreadable or in an unknown format. Transcripts hold secrets and file contents:
the route is loopback only, behind the same `Host` and `Sec-Fetch-Site` guards as the detail,
refuses a foreign `Origin`, and sends `no-store` and `nosniff`; anyone who can open the dashboard
can read the tail, as with the log routes.

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
line. A job the factory controller gave up (its newest `runner.stopped` event, while the job is
still at the stage and status it recorded, no newer blocker event exists, no live session or
escalation explains it, and a completed job is not merged) shows `Stopped by the controller`
with the recorded code and reason on the board and in the summary, and the recorded `next`
command as its next line; this is display only and decides nothing. When a session may resume
the job, a **Copy resume command** button for
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

**References** in the detail are links where the destination is known (decision
2026-11-20-serve-recorded-logs). Every PR href is the read model's `links.pr`, the recorded PR URL
only when it is http(s); prose (the plan reason, the Next line, the CI line and guidance) links
only whole, punctuation-bounded occurrences of that URL, at most three per string. A commit SHA
links to `<links.repo>/commit/<sha>` only for a `github.com/<owner>/<repo>` identity and only when
the commit is known to be on the remote: the CI head, a `branch.pushed` head, the merged head and
commits, the entries of the branch's (or since-the-merge) list from the first such commit on, and
a base commit fetched from `origin/`. Anything else, including any commit on another host, stays
text. Verification and CI logs link to the artifact route. Links open a new tab with
`rel="noreferrer noopener"`; the header's CI chip stays text.

**CI state** is shown with the commit it was read for, never on its own: the board's chip reads
`CI <rollup> @<sha7>` and the detail's PR tab carries
the full head, when it was observed, whether it is still the worktree HEAD (an old green verdict
for a commit that is no longer HEAD is marked as not current), GitHub's reason
from the last `orch gh ci` reconciliation, each failed required check with its GitHub log link (an
href only over https) and a `Saved log <path>` link that opens the log saved under the artifact
directory, and one line of guidance. The CI chip says only what CI
is doing. Repairs are rounds, so the board's Round column carries a `repairs n/m` caption under
the round indicator once a repair happened or CI is failing; in the detail the budget is stated in
the CI line (`n of m repairs used`). The detail's status panel uses the CI line as its summary and the
guidance as its next line. The chip is informational (blue) while checks are pending, green when
passing, red when failing, and warning (amber) only when GitHub reported no checks for the PR head.
Everything comes from
persisted fields (`src/server/status.ts` `ciView`): the rollup columns, the newest `ci.observed`
event, and the `job.completed` event. A ci-stage escalation gets its own blocker (`CI stopped`)
naming the cause from the recorded reason code and outcome: repair budget spent, no checks for the
PR head, checks that never reached a verdict, a PR closed without merging, or a head that moved
outside the job, or a PR merged by a human whose head the delivery gate refused. A completed job
says how it completed: on GitHub's verdict, by a human merging the PR at the verified head before
CI finished (line "PR merged by a human before CI finished; CI was <status> for <sha7>.", chip
`merged before CI`, outcome `completed: merged`), by a human close-out (chip `human close-out`,
with the reason in the events), or, for jobs older than the ci stage, with no verdict recorded at
all. On the board, a completed row's CI chip is secondary (outlined) beside its status label, and
is hidden when the outcome is `merged` and CI is passing or the merge came before CI finished; the
detail's PR tab keeps the CI chip and line either way.

**Controls** reuse `src/ops/actions.ts`, which runs the same validated transitions as the CLI as a
short-lived `dashboard` session and then releases the job. The detail API lists the actions the
workflow allows in the current state (`allowedActions`) and the client renders only those; the
server re-checks every request. Each control except Refresh PR states its effect in one sentence,
as a hover/focus tooltip and again in its confirm dialog: Resume says it moves the job without
fixing anything, Request rework and Request review round name the next review round (`round + 1`
of `maxRounds + 1`: a human resume grants that round by raising `maxRounds`), and Cancel says the job ends for good with its worktree and branch kept. `Resume at <stage>` (the `approve` action, labelled by the stage
it sends the job to) is the primary control only when the approver escalated (`decision.md` says
ESCALATE); for any other blocker it is demoted behind a warning, because resuming moves the job
without fixing anything. Request rework is primary only when reviewers
still requested changes at the last allowed round, which is where the workflow itself would go
back to `build`; for interruptions, verification failures, and unclassified escalations every
control stays neutral, since the right transition is a human call.

| Action                     | Allowed when                                                                                                                                                                                                                                             | Effect                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Resume at <stage>`        | stage `needs-human`                                                                                                                                                                                                                                      | `resume --to <stage>` (default: where it came from)                                                                                         |
| Request review round       | round ≥ 1, not finished                                                                                                                                                                                                                                  | `escalate` + `resume --to review` (opens a new round)                                                                                       |
| Request rework             | not finished                                                                                                                                                                                                                                             | `escalate` + `resume --to build`                                                                                                            |
| Accept verification policy | worktree `factory.json` differs                                                                                                                                                                                                                          | snapshot it as the job's policy (`jobs.policy`)                                                                                             |
| Accept delivery            | `needs-human` from `ci`, PR head observed, and GitHub reported no checks at all or the PR was merged by hand; a reason is required                                                                                                                       | `resume --to completed`, recorded as a human close-out                                                                                      |
| Cancel job                 | not finished                                                                                                                                                                                                                                             | `cancel`                                                                                                                                    |
| A choice (`answer`)        | stage `needs-human` (the newest `job.blocked`'s choices, or the default ones); the button is enabled when the action the choice maps to is allowed                                                                                                       | that action, with reason `dashboard: answer "<label>"` plus the note; a notice for the next session unless the job finished                 |
| Edit spec (`edit-spec`)    | stage `needs-human`, `returnStage` `spec`, not finished; the detail carries `spec.md` inline                                                                                                                                                             | validates `content` as `spec.md`, writes it, `artifact add spec.md --replace`; the job stays in `needs-human`                               |
| Archive                    | status `completed` or `cancelled`, not archived                                                                                                                                                                                                          | sets `jobs.archivedAt`; event `job.archived`                                                                                                |
| Unarchive                  | status `completed` or `cancelled`, archived                                                                                                                                                                                                              | clears `jobs.archivedAt`; event `job.unarchived`                                                                                            |
| Merge                      | completed on GitHub's verdict, `prState` `ready`, `ciStatus` `passing`, `ciHead` set                                                                                                                                                                     | `gh pr merge --merge --match-head-commit <ciHead>`                                                                                          |
| Refresh PR                 | PR recorded and not merged; the job is finished or in `needs-human`                                                                                                                                                                                      | re-reads the PR; records `prState` (`pr.observed`)                                                                                          |
| Remove worktree            | status `completed` or `cancelled`, `prState` `merged`, worktree recorded                                                                                                                                                                                 | `orch worktree remove`: refused if dirty; branch kept                                                                                       |
| Fix merge conflicts        | stage `approve`, `pr`, or `ci` (not finished), or `completed` with `prState` `draft`/`ready` and not superseded; and `git merge-tree` against the local base ref reports conflicting files, or the newest recorded GitHub observation says `CONFLICTING` | `approve`/`pr`/`ci`: `orch worktree integrate`, `rework` to `build` (no CI repair spent); completed: a `(re-land)` job, this one superseded |

**Fix merge conflicts** integrates the base as the `dashboard` session; a conflicting merge is
aborted and recorded and the job goes back to `build` as pending, where a resumed builder resolves
it. orch resolves nothing and starts no session; in `approve` or `pr` a merge that came out clean
after the fetch needs fresh verification instead. In `ci` the rework spends no CI repair (a base
conflict is not a CI failure, so an exhausted job still goes to `build`), and a clean merge reworks
too, because only the `pr` stage may push the new head. A completed job cannot transition, so for
one whose open PR GitHub reports `CONFLICTING` the click re-reads the PR, requires `OPEN` and
`CONFLICTING`, creates a job titled `<title> (re-land)` (created only: no claim, worktree, or
session) whose description adds the re-land sentence, and records the old job as superseded by it.
When its worktree is created, its branch starts at the old job's branch head, and its builder
merges the base and resolves the conflicts in `build`.
Start it with `/factory <new id>` in a new session; once its PR merges, close the old PR with
`gh pr close <old url> --comment "Superseded by <new url>."`. GitHub's `mergeable` answer is
recorded on `pr.observed` and `ci.observed` (Refresh PR, `orch gh ci`), so it is only as fresh as
the last read; an observation without the field counts as unknown
(`docs/decisions/2026-11-19-dashboard-fixes-base-conflicts-as-rework.md`).

**Choices.** Every job waiting in `needs-human` offers concrete answers: the ones a session passed
with `orch job transition <id> escalate --choice "<kind>[:<stage>]=<label>"` (`docs/workflow.md`),
or the default ones the escalation's reason implies (`defaultChoices`, decision
2026-11-24-default-needs-human-choices), with the default primary in front when no recorded
choice continues the job; an older `job.blocked` that recorded none gets the defaults. The detail
view's `choices` lists them in order, each with the dashboard action it maps to (`resume:<stage>`
is Resume at that stage, `rework` Request rework, `review` Request review round,
`accept-delivery` Accept delivery, `accept-policy` Accept policy, `cancel` Cancel) and whether
that action is in `actions`, plus `effect`, one line on what picking it does; `needed` is one plain
sentence of what is needed, naming the available choices. Both come from `needsHuman` in
`src/ops/actions.ts`, the one view the status mail, the controller's stop line and end-of-session
summary, and `orch status` also print, each choice with its link
`http://127.0.0.1:4777/#/jobs/<id>?choose=<n>` (`n` its index; a choice whose action is not allowed
is listed as not available, without a link). The job detail shows them first, under the header and
above the Status and Escalation sections, as a **Needs you** block: the sentence, then one button
per choice labelled with its label (plain text) beside its effect line; the first is the primary
(contained) button, the others outlined, and a button whose action is not allowed is disabled.
Opening a `?choose=<n>` link shows the page with choice n's confirm dialog open; it posts nothing,
and an out-of-range, unavailable, or no longer offered choice opens no dialog (decision
2026-11-26-choose-link-opens-a-confirm).
Under the buttons one line, `afterAction`, says what happens after an answer: "the controller
continues it" only while a queue-mode `orch start` runs, its repository filter covers the job, and
its session passed the job's ticket over as an escalation (`controllerContinues` in
`src/ops/runner-state.ts`, the retake rule of `docs/workflow.md`); otherwise "run orch do
<ticket>", or the resume command for a job with no ticket. A button opens a confirm dialog with the mapped action's
effect sentence and an optional note. Confirm posts `{ action: 'answer', choice: <index>, reason?:
<note> }`: the server re-reads the choices inside the lease, refuses (422) an index out of range or
a job no longer offering that choice, and otherwise runs exactly the mapped action, with its own
refusals; the label stands in for the reason Accept delivery requires. When the job is still
unfinished afterwards the answer is posted as a notice (`Human answered "<label>": <note>`), which
the next `orch factory next` shows to whichever session continues the job, and the message says
the same as `afterAction`. No session is started. The
other controls stay available.

Accept delivery is the only control that completes a job by hand. It is listed by the same rule the
transition applies (`cannotAcceptDelivery` in `src/core/workflow.ts`), so it never appears while
checks are pending or failing, it is never the primary control, and it refuses an empty reason; the
`job.completed` event carries `acceptedByHuman: true` and the reason, and the dashboard shows the
job as completed by human close-out rather than as a passing build. It does not merge or mark the
PR ready.

**Merge** is a plain Cancel / Merge confirm naming the PR and the short head SHA. It runs the same
operation as `orch job merge` (`mergeJob`, see [workflow.md](workflow.md#merging)), as a human's
decision: no repository opt-in is needed, and a conflict is refused here instead of re-landed (Fix
merge conflicts does that). The server reads the PR from GitHub again and merges only if it is the
job's own PR, open, not a draft, its head is still `ciHead`, and GitHub reports it `MERGEABLE`;
otherwise it refuses and nothing is called. After the merge it reads the PR once more and records
what GitHub confirms: the merge commit (shown on the Git tab next to the merged head) and, when the
job has a ticket with no unchecked checklist item, the ticket's completion. A merge GitHub refuses
(for example a repository that disallows merge commits) is recorded as `pr.merged` with
`ok: false` and gh's message, and `prState` stays `ready`. It never deletes the branch, bypasses
protection, or queues an auto-merge. The button is not offered for a superseded job
(`docs/decisions/2026-11-20-orch-job-merge.md`). **Refresh PR** re-reads the PR
and records only its state, never the CI verdict, stage, or status; a PR merged on GitHub by hand
shows as merged after it, and on a ci escalation that makes Accept delivery available. Nothing
polls GitHub: the board's periodic refresh re-reads the database only.

**PR phase.** The board's PR / CI column and the detail header's second line show a chip (glyph and label) for
where the PR stands, from recorded fields only (`prPhase` in `src/core/workflow.ts`): `no PR`,
`draft` (CI not passing yet), `CI running`, `CI failing`, `ready to merge` (completed on GitHub's
verdict, marked ready, CI passing), `ready marking failed` (completed on the verdict but the PR is
still a draft: run `gh pr ready`, then Refresh PR), `merged`, and `closed`. `ready to merge` is
orch's record; GitHub's live mergeability is checked only when Merge is clicked. On the board,
where Refresh PR is allowed (the row's `pr.refreshable`, from `cannotRefreshPr`), the chip is a
button that runs Refresh PR for that job without opening it; a refusal shows under the chip.

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

**Tickets** (`#/tickets`) is the global queue of [tickets.md](tickets.md), read and changed
through the same `/api/tickets` operations as `orch ticket`. Nothing about readiness, order,
lifecycle, or dependency cycles is decided in the browser: the page shows the `ready`,
`blockedBy`, and `activeJob` the server computed, and every write is one ticket action that the
server validates.

- **Factory status** is the shared header's box (above), on this and every section: what
  `orch status` prints, from `GET /api/runner` (`runnerStatus`, read-only). The body is
  `{ controllers: ControllerStatus[], last, build, waiting }`: `controllers` has one entry per
  open controller slot (one per repository, or the whole-queue one), live ones first, then by
  `startedAt`, each with `scope` (the repository as shown), `state` (`running` or
  `interrupted`), `pid`, `mode`, `repo`, `startedAt`, `stop`, `current`, and `next`; `last` is
  the session that ended last over every slot, with its `scope`; `build` appears once; `waiting`
  is the union over every slot's session, once per job. With no open slot `controllers` is `[]`
  and the strip shows one `idle` line. The strip shows one line per controller: whether it is
  `running` or `interrupted`; its mode (one ticket for `orch do`, or the queue of one repository
  or of every repository); the ticket key, job, stage, status, and repository in flight (links to
  ticket and job; only what `/api/runner` returns, so no ticket title); what it
  waits for (`agent`, `ci`, `merge`, or a person); a requested stop (`now`, or after this ticket);
  what happens next, in one sentence; and how the last finished session ended, with its reason and
  its done-of-attempted counts. There is no control here; the controller is started, stopped, and
  resumed from the CLI only. The strip does not list Claude sessions: each child's outcome is a
  `runner.session` event, and a stop's reason a `runner.stopped` event, on the job's Events tab
  ([operations.md](operations.md#runner-events-on-the-job)).
- **The list** opens with the highest-priority ready ticket and the number ready ("No ticket is
  ready." when none is). That is the head of the queue, not a promise: the controller passes over
  a repository without the merge opt-in. The list itself reads three routes per poll
  (`/api/tickets?view=all`, `?view=order`, `/api/jobs`), never `/api/runner`. It has Queue, ID, Title, Repository, Priority, Effort (days), State, Area / Type,
  Created (local date and time), Job, and Blocked by. Queue is the ticket's position in `GET /api/tickets?view=order`, the server's proposed
  order of the open tickets; an open row's Up, Down, and Top buttons post the `move` action and
  read the queue again. They move within the global order, not the filtered rows, as
  `orch ticket move` does, so with a filter on a click may pass a hidden ticket. An open row's
  Queue cell is a number input (`Position of <key>`) holding its position: typing a number and
  pressing Enter posts one `move` with `position` and the row's revision, so the ticket lands
  there and the tickets in between shift by one; leaving the field without Enter puts the
  current position back and sends nothing. A refusal (out of range, past a dependency, stale
  revision) shows in the banner. **Show** picks `current` (the default: tickets in progress, then the
  open ones in queue order), `ready`, `blocked`, `in-progress`, `done`, `dropped`, `duplicate`,
  or `all`; Repository, Priority, Area, and Type narrow it, and Search matches the key (`0085`),
  the id (`#85`), and the title. The filters are
  kept while a ticket or a job is open. Priority is a select in the row: changing it is an `edit`
  with the ticket's revision, after which the queue is read again, so the order shown is always
  the server's.
- **State** is derived, never stored. An open ticket is `ready` or `blocked`, and a blocked one
  lists the server's reasons in Blocked by, with the ticket or job each names as a link. A ticket
  in progress shows what its job is doing, from the job's own liveness on the board (`running`,
  `stale`, `idle`, `needs human`, `failed`, `interrupted`), or `awaiting CI` while that job is in
  the ci stage. With no unfinished job it is `awaiting integration` (the last job finished and
  its PR is not merged), `merged, not closed` (the PR merged but did not close the ticket: an
  unchecked checklist item or an unverified merge), or plain `in progress` (marked by hand).
  `done`, `dropped`, and `duplicate` are the lifecycle status. The Job column names the job the
  state was read from: its stage while it is unfinished, how it ended otherwise.
- **New ticket** takes a title, repository, type, area, priority, effort, and a Markdown
  description, and opens the ticket it created. Creation needs a checkout path, so Repository
  offers the checkouts of existing tickets and jobs; the first ticket of a repository is filed
  with `orch ticket add` from inside it.

**Ticket detail** (`#/tickets/<id>`) shows the title, id, state, repository, status, priority,
type, area, effort, and, when blocked, the reasons. **Edit** turns the title, priority, type,
area, effort, and the Markdown description into one form with Save and Cancel; Save sends a
single `edit` with only the fields that changed and the revision the form was opened at. The
description is rendered with the dashboard's Markdown subset; task items (`- [ ]`, `- [x]`) show
as read-only boxes and are changed by editing the Markdown. Start, Done, Drop, Mark duplicate,
and Reopen are offered by status and run the ticket's lifecycle action (Drop and Mark duplicate
ask first; Start marks the ticket in progress and starts no job); a transition the server refuses
is shown in its own words. Links lists what the ticket depends on, what it blocks, and what it is
related to, each a link; a ticket id and Add dependency or Add related adds one, and the
`Remove dependency on <key>` or `Remove related ticket <key>` button after a Depends on or Related
chip removes it, leaving focus in that row (Blocks chips have none: that link belongs to the other
ticket). Jobs lists every job that worked on the ticket with its stage, status, PR
state, and supersession, each linked to its job detail; a job's header links back to its ticket.
Merge receipt (only once a job of the ticket completed) renders `receipt.markdown` from
`GET /api/tickets/<id>`: the newest completed job's evidence summary (`src/ops/receipt.ts`),
including the merge evidence once merged. History is the ticket's events, oldest first.

A write based on an outdated revision is refused by the server (409) and never applied over the
other change. An action then shows the refusal and the current ticket. An edit keeps the draft,
shows the current ticket beside it, and says nothing was saved; saving again applies the user's
own changed fields to the current revision. Polling replaces only what was read from the server:
an open draft is never touched by it.

**Security.** The server binds `127.0.0.1` only, checks the `Host` header against its own
loopback origins (DNS rebinding), rejects cross-site `Sec-Fetch-Site`, and for state-changing
requests requires a same-origin `Origin`, `Content-Type: application/json`, and a per-process
CSRF token obtained from `/api/session` (which a foreign origin cannot read). Bodies are limited to
64 KB and validated field by field; unknown fields are rejected. Static files come only from
`web/dist`; `GET /api/jobs/<id>/artifacts/<path>` serves only that job's registered artifacts plus
the verification and CI logs orch recorded for it (a check's `outputPath`, a `ci.observed`
failure's `log`), matched exactly and shape-checked (`verification/<run>/<check>.log`,
`ci/<sha7>/<name>.log`), and every file is confined by real path to the job's real artifact
directory, so a junction or symlink cannot lead out (no arbitrary path reads; refusals are 400 for
a malformed path, 422 otherwise). Logs are sent as `text/plain` with `nosniff`. Job rows never
include the owner token; there is no shell-execution endpoint. Responses
carry a CSP, `nosniff`, and `no-store`.

**Development.** `npm run web:dev` starts Vite with hot reload on `127.0.0.1:5173`, proxying
`/api` to a running `orch ui`. `npm run build` compiles both the CLI and `web/dist`.
`npm run test:e2e` runs the Playwright suite against a seeded scratch database (first time:
`npx playwright install chromium`). Each run seeds its own `mkdtemp` home, starts `orch ui` on a
free port, and hands the URL and seeded ids to the workers through a state file under that home,
so two runs on one machine never share a port, a database, or a state file. `ORCH_E2E_PORT` pins
the port (a busy port is reported, never silently replaced by another server) and
`ORCH_E2E_KEEP=1` leaves the scratch home in place for inspection. The Tickets section is covered
by `web/src/Tickets.test.tsx` (against a stand-in for the ticket API), `tests/ticket-server.test.ts`
(the real routes, `/api/runner` included), and one Playwright walk through two seeded tickets.
