# Workflow internals

The rules `orch` enforces for a job, in detail. `README.md` gives the overview; this file is
the reference for stages, artifacts, evidence, worktrees, GitHub, and ownership.

## Workflow

```
spec → build → review → approve → pr → ci → completed
                 │  changes            │     │
                 └──────→ build        │     └─ (requires passing required checks for HEAD)
                 ▲                     └─ (requires a recorded PR)
                 └── rework (CI failed, repairs < max) ── ci
         any stage ── escalate ──→ needs-human ── resume --to <stage> ──→ back
```

**Stage** is where the job is; **status** is what is happening there:
`pending`, `running`, `blocked`, `interrupted`, `completed`, `failed`, `cancelled`.

Claude requests an action; `orch job transition <id> <action>` validates and applies it:

| Action     | Allowed when                                                                     | Effect                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `start`    | status `pending`, `failed`, or `interrupted`                                     | status `running`                                                                                                             |
| `complete` | status `running` and required artifact registered                                | next stage, status `pending` (see below)                                                                                     |
| `fail`     | status `running`                                                                 | status `failed`                                                                                                              |
| `escalate` | any live stage                                                                   | stage `needs-human`, status `blocked`, remembers origin                                                                      |
| `resume`   | `needs-human`, or status `interrupted`/`failed`/`blocked`                        | back to the origin or `--to` stage, status `pending`                                                                         |
| `rework`   | stage `pr` (base integration needs the builder) or `ci` (required checks failed) | stage `build`, status `pending`; re-review follows; from `ci` counts a repair, or `needs-human` when `maxCiRepairs` is spent |
| `cancel`   | any job not already finished                                                     | status `cancelled`                                                                                                           |

Required artifacts, relative to the job's artifact directory and registered with
`orch job artifact add`: `spec.md`, `build.md`, `round-N/consolidated.md`, `decision.md`, `pr.md`.
Registration checks the file is inside the artifact directory (no absolute paths or `..`), is
`.md`, exists, is non-empty, and has the structure its path requires (`src/core/artifact-rules.ts`):

| Artifact                    | Required headings                | Marker line (exactly once)        |
| --------------------------- | -------------------------------- | --------------------------------- |
| `spec.md`                   | Goal, Scope, Acceptance criteria |                                   |
| `spec-review-1.md`, `-2.md` | Findings                         | `VERDICT: PASS` or `CHANGES`      |
| `build.md`                  | Summary, Validation              |                                   |
| `round-N/review-<name>.md`  | Findings                         | `VERDICT: PASS` or `CHANGES`      |
| `round-N/consolidated.md`   | Findings                         | `BLOCKING: <count>`               |
| `decision.md`               | Rationale                        | `DECISION: APPROVE` or `ESCALATE` |
| `pr.md`                     | Validation, Known limitations    |                                   |

Headings match case-insensitively at any level. The marker is stored on the artifact row and the
workflow reads it: `review record --verdict pass` is refused if the file says `CHANGES`, and
`approve` cannot complete unless `decision.md` says `APPROVE` (use `escalate` instead). Files with
other names (evidence, notes) are accepted without structure checks. A file on disk is not evidence
of completion until it is registered.

**Replacement is explicit.** Registering the same path with identical content is a no-op.
Registering changed content fails unless `--replace` is given, and is then logged as
`artifact.replaced` with the previous hash, so the history of what was accepted survives. Combine
with `--revision <n>` to also reject the replacement if the job moved on meanwhile. Review files are
per round (`round-N/`) and are never overwritten by later rounds.

**Spec challenge.** In `spec`, after `spec.md` is registered, `factory-spec-challenger` (an
independent subagent, Sonnet by default, role `spec-challenger` in `factory.json` `models`)
reviews it against the request and the repository's conventions and writes `spec-review-1.md`.
Registering a challenge is refused before `spec.md` is registered, and `spec-review-2.md` is
refused unless `spec-review-1.md` says `CHANGES`; no other `spec-review-N.md` is accepted. The
challenge row records the sha256 of the `spec.md` registered at that moment. `complete` from
`spec`, and `resume` from a `needs-human` that was escalated from `spec` to any other stage, are
refused unless the highest-numbered challenge says `PASS` and was bound to the `spec.md` registered
now; completion also re-reads the challenge files, so an edited file is refused as changed on disk.
On a first `CHANGES` the plan has the writer revise `spec.md` once (`--replace`) and a second
challenger run writes `spec-review-2.md`; a second `CHANGES` makes the plan `escalate`, keeping
the objections in the registered file. A challenge whose spec was replaced is challenged again
(`--replace` on the same file). The loop bound is the plan's, not a code cap; see
[the decision](decisions/2026-11-17-spec-challenger-gates-the-spec.md).

**Review rounds.** Completing `build` increments the round and enters `review`; so does `resume`
from `needs-human` into `review` (a requested re-review is a new round, keeping earlier verdicts as
history), while resuming an interrupted `review` keeps its round. While `review` is
`running`, each reviewer is recorded with `orch job review record` (without a verdict while it
runs, then with `--verdict pass|changes`); the verdict is read from that reviewer's own
`round-N/review-<name>.md`. `complete` is refused while any reviewer is pending, until all three
always-on reviewers (`security`, `correctness`, `code-quality`) have a verdict (UI reviewers join for
UI changes), and when the verdicts describe a commit other than the one `build.md` was registered
for. If every verdict is `pass` and `BLOCKING: 0`, the job moves to `approve`; otherwise the round is
a rejection and the job returns to `build`, unless it is the `--max-rounds`-th rejection (default 3),
in which case it escalates to `needs-human`. Rounds that passed and were followed by a CI repair or a
base-integration rework spend nothing; `maxCiRepairs` bounds CI repairs separately.

**PRs.** `orch gh pr create` records the job's draft PR (created or reused); the `pr` stage cannot
complete without one, and completing it enters `ci`, which only `orch gh ci` completes, in the call
that read `ciStatus: passing` for `ciHead` from GitHub, after the gate confirms `ciHead` is still
the worktree HEAD. Pushing, PR creation, and completing `pr` or `ci` share one gate: HEAD is the
approved commit or adds only clean base-integration merges to it, is verified, and runs under an
authorized policy. A PR whose head branch or base branch is not the job's is escalated by `orch gh
ci`, never completed. When `orch gh ci` completes the job on a passing verdict it then runs `gh pr
ready` for an open draft (event `pr.ready` with the head, `ok`, and gh's error; `prState` becomes
`ready` on success). That step comes strictly after the completion commits, changes no stage,
status, or CI field, and is never retried: a failure is reported and a human runs `gh pr ready`.
The PR state can be updated later (ready → merged, `orch gh pr status`) without changing the
workflow. `closed` means GitHub reported the PR closed
without merging; it is recorded from `orch gh pr status` or `orch gh ci`, never inferred from the
job, and a job whose PR is `closed` can neither complete nor be accepted with `resume --to
completed`.

**Superseded jobs.** When a job is abandoned and started again, `orch job supersede <old> --by
<new> --session <name>` records the replacement on the old job (`supersededBy`, event
`job.superseded`). Both jobs keep their rows, events, and artifacts; nothing is merged or deleted,
and nothing is inferred from matching titles. The two must belong to the same repository and may
not form a loop. The command is a short ownership episode like a dashboard action: it claims the
old job for a minute, records, and releases, refusing (without `--force`) while another session
holds a live lease on it. `orch job show` lists the jobs a job replaced (`supersedes`), and the
dashboard links both directions.

Every accepted change appends events (`job.created`, `job.claimed`, `job.released`,
`stage.started`, `stage.completed`, `stage.failed`, `artifact.registered`, `artifact.replaced`,
`review.recorded`, `job.blocked`, `job.resumed`, `job.interrupted`, `job.cancelled`,
`job.completed`, `job.superseded`, `worktree.created`, `worktree.adopted`, `worktree.removed`,
`integration.started`, `integration.completed`, `verification.started`,
`verification.completed`, `policy.authorized`, `job.reworked`, `branch.pushed`, `pr.recorded`,
`ci.observed`, `pr.ready`) in the same transaction. A `ci.observed` event from `orch gh ci` carries the head,
outcome, required-check list, every check's status and conclusion, and saved log paths.
`orch job events <id>` lists them.

**Usage.** `orch job usage <id>` reports what the records measure about where a job's time went:
wall-clock per stage visit (from `stage.started` to the event that ended it, with the review round
in effect), per reviewer run (from the pending record to the verdict), verification runs and their
check durations, CI repairs, re-runs, and observations, and the model the configuration assigns to
each role. It does not report tokens or money: Claude Code does not expose a subagent's token usage
or cost to the coordinating session or to `orch` through a supported interface, so the report says
`tokens.measured: false` with the reason rather than estimating (see decision 61).

## CI reconciliation

A draft PR whose checks fail is not a deliverable, so the `ci` stage exists to find out. The
coordinator runs `orch gh ci <id> --token <t>`, which reads from GitHub, for the PR's exact head
commit, the check runs and commit statuses plus the base branch's required-check configuration
(classic protection and rulesets), evaluates them with the pure rules in `src/core/ci.ts`, records
the observation on the job (`ciStatus`, `ciHead`, a `ci.observed` event listing every check), and
acts:

| GitHub reports (for required checks)                                                                             | `orch gh ci` does                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all succeeded (at least one check ran; skipped/neutral alone never count)                                        | completes the job in the same call, once the gate confirms a clean, verified HEAD; `orch job transition complete` is refused in `ci`, so no stored verdict is ever reused                                                                                                                                              |
| any queued or running, or none reported yet (first 5 observations)                                               | nothing: the result says how long to wait (`waitSeconds`: 60 s for the first five observations of a head, then longer, at most 300 s); the coordinator sleeps and runs it again, or releases the job after 20 pending observations in one session (`plan.ci.release`) and resumes later; the CLI never polls by itself |
| `failure`, `timed_out`, `cancelled`, `startup_failure`, or `stale` on an Actions check, first time for this head | once every other required check has finished: `gh run rerun <run> --failed` (recorded as `ci.rerun`, bound to the head, at most one per head), then `wait`; no source changes, no repair spent. Until GitHub reports the new attempt the old runs are ignored for 5 observations                                       |
| `failure` or `timed_out` again for the same head (or the re-run could not be requested)                          | saves each failing Actions job log under `<artifactDir>/ci/<sha7>/`, then `rework`: back to `build` with the reason; `ciRepairs` + 1                                                                                                                                                                                   |
| `cancelled`, `startup_failure`, `stale`, `action_required` again, or a required check that never reported        | `escalate`: not a code defect; a human re-runs the workflow and resumes `--to ci`                                                                                                                                                                                                                                      |
| no checks at all after the grace window, or only skipped ones                                                    | `escalate`: the factory does not invent success; a human adds CI (resume `--to ci`) or closes out with resume `--to completed`, which only this case and a merged PR allow                                                                                                                                             |
| PR head differs from the worktree HEAD or `origin/<branch>`                                                      | `escalate`: the branch changed outside the job; no verdict is borrowed from another commit                                                                                                                                                                                                                             |
| PR closed without merging                                                                                        | `escalate`; `prState` becomes `closed` (a cancelled job never implies a closed PR)                                                                                                                                                                                                                                     |
| `gh` or the API failed                                                                                           | exit 1, nothing recorded                                                                                                                                                                                                                                                                                               |

Without a configured required-check list every reported check counts as required; with one,
optional checks may fail. Either way the PR passes only when at least one check actually ran and
succeeded: skipped-only checks escalate even when a human made them required.
Check runs and statuses are read across every page (`gh api --paginate --slurp`, so `gh` 2.41 or
newer); a page that fails to load fails the whole observation rather than passing a partial list.
Runs with one name in one check suite are attempts of the same check (a re-run creates a new one in
the same suite) and only the newest counts; runs with one name in different suites, or whose suite
GitHub did not report, are independent checks and the worst one counts.
Private repositories on GitHub's free plan answer both configuration endpoints with HTTP 403, so
for them the list is always "unknown" and every reported check must pass.
A CI repair goes through the normal cycle: the builder gets the saved logs in its plan, commits,
`orch verify`, a new review round, a new approval, `orch gh push` to the same branch, and `orch gh
pr create` reuses the open PR. Repairs are bounded by `maxCiRepairs` (default 2, from the
orchestrator's `factory.json`; stored per job); when spent, the next failure escalates with reason
`max CI repair cycles reached`, keeping the PR and worktree. A job completes only when GitHub's
verdict for the current head is passing; `completed` therefore means "PR with passing required
checks, which orch marked ready for review" (or reported why it could not), never "PR created".
A human close-out (`resume --to completed`, the dashboard's Accept delivery) does not mark it ready.

## Recovery worker

Opt-in, never required (decision 2026-11-16-opt-in-recovery-worker). `orch recover run` repeats
passes in the foreground; `orch recover start` launches it detached and records its PID in
`<data>/recovery.pid`; `stop` ends it; `status` reports whether it runs and the last pass
(`<data>/recovery-status.json`). Each pass appends one line to `<logs>/recovery.log`.

A pass first probes GitHub (`gh api rate_limit`). While the probe fails it changes nothing and the
next pass backs off from 30 s, doubling, to 10 min. Otherwise every unfinished job is classified
(`src/core/recovery.ts`):

| Class           | When                                                                                              | The pass                                  |
| --------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `human`         | `needs-human`, blocked, failed, cancelled, completed, archived, superseded                        | nothing                                   |
| `active`        | another session holds a live lease                                                                | nothing (never `--force`)                 |
| `exhausted`     | 5 consecutive `recovery.failed` for the current CI head                                           | nothing; reported with the resume command |
| `recoverable`   | `ci` stage, PR recorded, no live lease (none, released, lapsed), pending, interrupted, or running | one episode as `orch-recovery`            |
| `needs-session` | any other stage (`spec` to `pr`, or `ci` without a PR) with no live owner                         | nothing; reported with the resume command |

The episode: `orch factory resume` (claim, rotate the token, interrupted work back to pending,
worktree kept), `start` unless the job is still running, one `orch gh ci`, then release unless
that call finished the job. It logs `recovery.attempted`; an error logs `recovery.failed` with the
reason and releases, so the next pass or a human can pick the job up. The fifth consecutive failure
for the same head escalates to `needs-human` with `recovery retries exhausted: <last error>`. A
claim by any other session resets the count. After a successful probe the next pass waits the
smallest CI `waitSeconds`, at least 60 s. The worker never launches, resumes, or messages a Claude
session and never removes a worktree.

## Worktrees

Each job gets one isolated Git worktree and branch, created from the job's base branch:

```sh
orch worktree create <id>            # <data>/worktrees/<repo slug>/<id>, branch factory/<id>-<title slug>
orch worktree show <id>              # branch, HEAD, dirty files, commits and changed files vs base
orch worktree adopt <id> --path <d>  # record an existing worktree of the same repository instead
orch worktree integrate <id>         # merge origin/<base> (or local base) into the job branch
orch worktree remove <id> [--repo <clone>]  # delete the directory; refused while dirty; branch kept
```

- Worktrees live under the runtime data directory, never inside a project checkout, and many
  repositories and jobs coexist (`worktrees/github.com-acme-alpha/job-1a2b3c4d`).
- `create` is idempotent: an existing worktree on the right branch is confirmed, a directory that
  vanished is recreated on the surviving branch, and a foreign directory at the path is an error.
  The checkout used is the job's recorded `repoPath` (or `--repo <other clone>`). The job's own
  repository is recognised by its Git common directory (so the checkout and every linked worktree
  qualify, whatever happened to `origin` since); another clone qualifies only when its `origin` is
  the job's recorded identity.
- `adopt` validates that the directory is the top level of a worktree of the same repository, on a
  branch, and not the primary checkout. Two jobs can never share a worktree or a branch; the
  database refuses it.
- `remove` and `integrate` refuse to run over uncommitted changes; `integrate` aborts cleanly on a
  conflict and reports the files, leaving the worktree exactly as it was. The branch and its
  commits are always preserved; `orch` never deletes uncommitted or unpushed work.

**Base integration** records an `integrations` row before Git runs (job HEAD, base ref and SHA,
merge base, the approval commit, the valid verification run) and completes it afterwards (result
HEAD, conflicts, files changed by taking the base, and `material`: files whose merge result matches
neither parent, from `git diff-tree --cc`). Outcomes: `up-to-date` (no commit), `merged`, `conflict`
(merge aborted), `interrupted`. In the `pr` stage a conflict, or a merge with material edits, moves
the job back to `build` (`rework`): the builder merges and resolves, and the result is verified,
reviewed, and approved again. A clean merge only needs a fresh `orch verify` on the new commit.
On resume, a row left `started` is reconciled from Git: a half-done merge (`MERGE_HEAD`) is
aborted, a merge that completed but was never recorded is recorded, anything else is marked
interrupted; the merge is never blindly retried. Delivery (`gh push`, `gh pr create`) then requires
that every commit since the approval is a merge with no material edits, that the policy has not
drifted without authorization, and that the latest verification run is valid for the pushed HEAD.

- `create`, `adopt`, `remove`, and `integrate` require the job's owner token; `show` is read-only.
- A job created from a linked worktree (`orch factory dispatch`, `orch factory start`, or
  `orch job create`, with `--repo` or the current directory inside it) records the primary
  checkout as `repoPath`, and without `--base` the primary checkout's current branch as its base,
  so that worktree stays adoptable (`jobRepository` in `src/ops/repo.ts`).

**Ownership is advisory at the filesystem level.** The CLI enforces that only the owner records
changes about a job, but any process with filesystem access (including a subagent pointed at the
wrong directory) can write into another job's worktree, the initiating checkout, the artifact
directory, or the SQLite file itself. What the CLI can do is refuse to count such writes as
progress: evidence is accepted only from a clean worktree at a recorded HEAD, re-hashed at every
gate, and the plan reports dirty files in both trees. Skills pass the worktree path explicitly to
every subagent. A worktree on the base branch, or inside the initiating checkout, cannot be adopted.

## GitHub integration

`orch gh` wraps the GitHub CLI (`gh`, authenticated with `gh auth login`). No GitHub SDK, no
tokens handled by `orch`.

```sh
orch gh repo [--repo <path>]            # nameWithOwner, default branch, identity for a checkout
orch gh issue <#N|N|url> [--repo <path>]
orch gh push <id>                       # git push --set-upstream origin <job branch>; never force
orch gh pr create <id> --body-file <md> [--title <t>]   # draft PR, or the existing open one
orch gh pr status <id>                  # state, draft/ready/merged/closed, CI rollup; recorded with --token
orch gh ci <id> --token <t>             # ci stage: GitHub's verdict for the exact PR head, acted on (see above)
```

Before pushing or creating a PR, `orch` checks that the job is in the `pr` stage, that
`decision.md` is a registered `APPROVE` tied to a commit, that every commit since that commit is a
base-integration merge (`rev-list --no-merges <approved>..HEAD ^<base>` is empty), that the job
branch is not the base branch, that GitHub's repository for the checkout matches the job's
identity, that the base branch exists on `origin`, and (for the PR) that `origin/<branch>` equals
the worktree HEAD. An open (or merged) PR for the
branch with the same base is reused instead of creating a duplicate. The PR is recorded on the job
(`prUrl`, `prState`) together with the CI rollup (`ciStatus`: `none`, `pending`, `passing`,
`failing`) but no head (`ciHead` is written by `orch gh ci` alone). `orch` never force-pushes, and marks the
PR ready only after `orch gh ci` completes the job; a recorded draft PR is not a passing CI run, which is what the `ci` stage then establishes.
No `orch` command merges: the only merge is a human clicking Merge in `orch ui` for a job completed
on a passing verdict, which merges exactly `ciHead`
(`docs/decisions/2026-11-15-humans-merge-from-the-dashboard.md`). After completion, `prState`
(`draft`, `ready`, `merged`, `closed`) changes only from GitHub's answer: `orch gh pr status <id>
--token` and the dashboard's Refresh PR record `prState` alone (event `pr.observed`) and keep the
completed verdict's `ciHead` and `ciStatus`; a merge is never inferred.
`orch gh ci` reads check runs and statuses with `gh api` for the head SHA (not the PR rollup), the
base branch's protection and rulesets for the required list, and Actions job logs for failures.

Tests never call GitHub: setting `ORCH_GH_SHIM=<file.cjs>` makes `orch` run `node <file> <args>`
instead of `gh`, and the suite uses a stateful shim plus a local bare repository as `origin`.

## Verification evidence

`orch verify <id>` is the only source of automated validation evidence. It runs the repository's
verification policy inside the job's clean worktree and records what happened; `build`, `approve`,
and `pr` cannot complete, and nothing is pushed, without a run that is still valid for the exact
HEAD.

```sh
orch verify <id> --token <t>     # run the policy; exit 1 on a failed required check or no policy
orch verify show <id>            # latest run and whether it is still valid for HEAD (read-only)
```

**Policy.** A `factory.json` at the repository root (committed, like any file) declares the checks:

```json
{
  "verification": {
    "commands": [
      { "id": "check", "command": "npm", "args": ["run", "check"], "required": true },
      {
        "id": "e2e",
        "command": "npm",
        "args": ["run", "test:e2e"],
        "cwd": "web",
        "required": false,
        "timeoutMs": 900000
      }
    ]
  }
}
```

`command` is an executable name resolved on `PATH` (no paths, no shell strings); `args` is an
array; `cwd` is relative to the worktree and must resolve inside it (links out are refused);
`required` defaults to true; `timeoutMs` defaults to ten minutes. Checks run in order and stop at
the first failed required one. Nothing from job titles, descriptions, issues, or the dashboard is
ever executed.

**Trusted baseline.** The effective policy is the `factory.json` at the merge base of the job
branch and its base branch: code the job did not write. A job editing its own `factory.json`
changes nothing by itself; `orch verify` keeps running the baseline, the plan reports
`policy.authorization: required`, `approve` and delivery are refused, and a human can accept the
proposed file from the dashboard (**Accept verification policy**), which snapshots it on the job
(`jobs.policy`) and makes every earlier run stale. A repository with no policy at the baseline
gets `configuration-required`: the gate stays closed until a policy exists on the base branch or a
proposed one is accepted. Nothing is invented.

**What a run records** (`verification_runs`, `verification_checks`): job, run id, commit and tree,
dirty files (always none, since a dirty worktree is refused), the policy fingerprint and where it
came from, start and end times, and per check the executable, argument array, working directory,
required flag, timeout, status (`passed`, `failed`, `timed-out`, `error`, or `pending` when an
earlier required check already failed), exit code or signal, duration, and the log file under
`<artifacts>/verification/<run>/<check>.log` with its SHA-256 (long output keeps its head and tail
and is marked truncated). All expected checks are rowed before anything runs, so an interrupted run
is visibly incomplete; starting a new run marks any still-`running` one `interrupted`.

**One at a time.** Checks run for one `orch verify` at a time per runtime home (a lock file,
`verify.lock` in the data directory, holding the holder's PID). Another `orch verify` waits inside
its own command, prints `orch verify: waiting ...` to stderr once, and polls; a lock whose holder
is no longer running is taken over. A job without a policy (`configuration-required`) never waits.
Under the lock the worktree and policy are checked again, since either may have moved meanwhile.

**Validity.** A run is evidence only while HEAD and its tree are unchanged, the worktree is clean,
the policy fingerprint matches the effective policy, every currently required check passed in
that run, and the run completed. Anything else is reported as the reason it is stale.

**Sensitive changes.** The plan classifies the job's diff (`plan.sensitive`): application tests
(added, modified, deleted), test or lint configuration, CI workflows, dependency manifests, and
`factory.json`, for JavaScript, Python, Go, Rust, and Ruby layouts; the diff of changed test files
is scanned for skipped, focused, or commented-out tests and for removed test definitions, and the
policy is diffed against the baseline (added, removed, modified, weakened checks). Newly added
tests alone need no special attention; everything else sets `needsReview`, and `orch` refuses a
`round-N/consolidated.md` or `pr.md` that lacks a `Sensitive changes` section naming each path.
Reviewers are told to read those diffs. Classification is a label, not a block: disabling a test is
caught because a reviewer must address it, not because the CLI understands the test.

## Ownership and resumability

Several VS Code sessions may run at once, so each job has at most one owner.

- `orch job claim <id> --session <name>` atomically takes the job and returns a **token**. The lease
  lasts `--lease` minutes (default 30). Pass the token as `--token` or `ORCH_TOKEN` on every
  mutation; `ORCH_SESSION` can stand in for `--session`.
- **Renewal is explicit.** There is no daemon. Every successful mutation by the token holder extends
  the lease by the claimed length. `claim` or `resume` again, even from the same session name,
  issues a new token and kills the old one: two processes resuming under one name cannot both keep
  driving the job. A session that goes quiet simply lets the lease lapse. `orch verify` renews
  the lease without rotating the token when it starts (before waiting for the verify lock), every
  five minutes while it waits, and with each record it writes.
- **Expiry and takeover.** Another session may claim an expired lease, or any lease with `--force`.
  Takeover rotates the token, so commands from the previous owner fail with exit code 4, and marks
  a `running` job `interrupted` so it must be explicitly resumed.
- **`orch job resume <id> --session <name>`** claims the job and, if it was interrupted, failed,
  blocked, or in `needs-human`, puts it back to `pending` (use `--to <stage>` from `needs-human`).
  It returns the full job detail: artifacts, reviews, recent events, and the artifact directory.
  Registered artifacts from completed stages are preserved, so a new session can continue without
  the original conversation.
- **`--revision <n>`** on any mutation rejects the command if the job has changed since the caller
  last read it (optimistic concurrency). Re-registering the same artifact or reviewer is idempotent;
  repeating `start` on a running stage is refused.
- `orch job release <id>` gives the job up voluntarily.
- **Finishing releases.** The write that makes a job `completed` or `cancelled` clears its owner and
  lease, and its events name the finishing session. `orch gh ci` holds the lease while it marks a
  draft ready; the `pr.ready` write releases it. A later write to a finished job (archive,
  supersede, recording PR state) claims it first.

### Checkout ownership (cooperative)

A job lease protects the job record; it does not stop two Claude Code sessions from editing the
same checkout, which is how the intermittent failures in decision 45 happened. `orch
checkout` adds a lease per **checkout**, identified by its Git directory (`.git` for the primary
checkout, `.git/worktrees/<name>` for each linked worktree, compared canonically so case, 8.3
aliases, and junctions are one checkout and two repositories that merely share a directory name are
not). Claims live as JSON files under `<data>/checkouts/`, never inside a repository and never in
the database, so the guard can run from any checkout without touching the shared store.

- `orch checkout claim --session <s> [--path <p>] [--lease <min>] [--force]` takes or renews the
  checkout containing `<p>`; exit 4 while another session's lease is live. `--force` takes it over
  deliberately. `status` and `list` are read-only; `release [--all]` gives claims back.
- `orch checkout hook` is a Claude Code hook. This repository ships it in `.claude/settings.json`:
  `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` claims the checkout that contains the file
  and exits 2 (the tool call is refused, with the holder and the recovery command as the reason)
  while another live session holds it; `SessionStart` only reports a live holder as context, so a
  read-only session never claims anything; `SessionEnd` releases the session's claims. The claim
  records the session's transcript file (`transcript_path` in the hook payload), which Claude Code
  appends to on every turn and tool call, so the holder stays live for 30 minutes after its last
  activity, not its last write: a session that reads, reasons, or runs a long test suite without
  editing keeps its checkout. A session that died without `SessionEnd` lets both lapse, after
  which the next session reclaims; the old session's next write is then refused instead of racing.
  The shipped command runs this checkout's own source when `src/cli/checkout.ts` exists, otherwise
  the installed `orch` if it has the `checkout` command, and otherwise prints a warning and exits
  1: Claude Code shows the warning and lets the edit through, so a session on a branch without the
  guard sees that it is unprotected rather than being locked out or silently exposed (Claude Code
  keeps the hook configuration it loaded at startup across branch switches, and an exit 2 from any
  cause would refuse every write). To protect every repository, add the same three entries to
  `~/.claude/settings.json` with the installed `orch` (`orch checkout hook`) instead of the
  source path.

This detects accidental sharing of one checkout between sessions. It is not filesystem isolation:
Bash commands are not hooked, a process that writes without asking is not stopped, and the hook
session id is Claude Code's, unrelated to the `--session` names used for job leases. Hooks run
with Claude Code's own environment, so claims go to the `ORCH_HOME` Claude Code was started with
(by default the user's data directory), not one set inside a Bash command; sessions see each
other's claims only when they share that location. Two sessions reclaiming one lapsed claim in the
same instant is last-writer-wins, and the loser's next write is refused.

## Checkout ownership (cooperative)

A job lease protects the job record; it does not stop two Claude Code sessions from editing the
same checkout, which is how the intermittent failures in decision 45 happened. `orch
checkout` adds a lease per **checkout**, identified by its Git directory (`.git` for the primary
checkout, `.git/worktrees/<name>` for each linked worktree, compared canonically so case, 8.3
aliases, and junctions are one checkout and two repositories that merely share a directory name are
not). Claims live as JSON files under `<data>/checkouts/`, never inside a repository and never in
the database, so the guard can run from any checkout without touching the shared store.

- `orch checkout claim --session <s> [--path <p>] [--lease <min>] [--force]` takes or renews the
  checkout containing `<p>`; exit 4 while another session's lease is live. `--force` takes it over
  deliberately. `status` and `list` are read-only; `release [--all]` gives claims back.
- `orch checkout hook` is a Claude Code hook. This repository ships it in `.claude/settings.json`:
  `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` claims the checkout that contains the file
  and exits 2 (the tool call is refused, with the holder and the recovery command as the reason)
  while another live session holds it; `SessionStart` only reports a live holder as context, so a
  read-only session never claims anything; `SessionEnd` releases the session's claims. The claim
  records the session's transcript file (`transcript_path` in the hook payload), which Claude Code
  appends to on every turn and tool call, so the holder stays live for 30 minutes after its last
  activity, not its last write: a session that reads, reasons, or runs a long test suite without
  editing keeps its checkout. A session that died without `SessionEnd` lets both lapse, after
  which the next session reclaims; the old session's next write is then refused instead of racing.
  The shipped command runs this checkout's own source when `src/cli/checkout.ts` exists, otherwise
  the installed `orch` if it has the `checkout` command, and otherwise prints a warning and exits
  1: Claude Code shows the warning and lets the edit through, so a session on a branch without the
  guard sees that it is unprotected rather than being locked out or silently exposed (Claude Code
  keeps the hook configuration it loaded at startup across branch switches, and an exit 2 from any
  cause would refuse every write). To protect every repository, add the same three entries to
  `~/.claude/settings.json` with the installed `orch` (`orch checkout hook`) instead of the
  source path.

This detects accidental sharing of one checkout between sessions. It is not filesystem isolation:
Bash commands are not hooked, a process that writes without asking is not stopped, and the hook
session id is Claude Code's, unrelated to the `--session` names used for job leases. Hooks run
with Claude Code's own environment, so claims go to the `ORCH_HOME` Claude Code was started with
(by default the user's data directory), not one set inside a Bash command; sessions see each
other's claims only when they share that location. Two sessions reclaiming one lapsed claim in the
same instant is last-writer-wins, and the loser's next write is refused.
