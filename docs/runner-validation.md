# Controller recovery paths: validation in real runs (ticket 0099)

Until now, four recovery paths of the factory controller (`src/ops/run.ts`, decision
[2026-11-21-foreground-factory-runner](decisions/2026-11-21-foreground-factory-runner.md)) had
run only against test stand-ins: controller-side CI polling, the merge-conflict re-land, stop and
resume during real Claude execution, and POSIX process-group termination of the child. On
2026-11-24 they were run with the real controller starting real headless `claude -p "/factory
<job>"` children. This page records the scenarios, commands, outcomes and evidence. Each scenario
is labelled with its tier:

- **real-with-stand-in-GitHub**: the real `orch` controller, real Claude sessions, real Git with a
  local bare `origin`. GitHub is the stateful `gh` stand-in described below.
- **untested**: not run, with the reason.

## Environment

| Item                            | Value                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host                            | Windows 10 Pro N 10.0.19045, Git Bash                                                                                                                                                                                                                              |
| `claude --version`              | 2.1.323 (Claude Code), the child ran `claude-opus-5-5`                                                                                                                                                                                                             |
| `node --version`                | v24.19.0                                                                                                                                                                                                                                                           |
| `orch` (controller and child)   | The installed `orch` (`E:\github2\orch\dist`, the primary checkout clean on `main` at `e4670b917d8cb80d5817ec8df511ec618d069bb3`, `dist/` built 2026-11-23 23:56, after that commit). The controller was run as `orch`, and the child's gates call the same binary |
| Child arguments                 | The defaults (no `runnerClaudeArgs` set)                                                                                                                                                                                                                           |
| Skill and agents the child read | The user's global `/factory` skill and agents, unchanged; the child wrote its own transcripts under `~/.claude/projects`, as Claude Code always does                                                                                                               |

### Isolation

Every run used its own fresh temporary `ORCH_HOME` and its own disposable repository under
`C:\Users\Jon\AppData\Local\Temp\orch0099\<scenario>\`. Nothing from these runs reached the real
store or a real repository:

- This validation ran inside an outer `orch start` session. Each scenario shell set a fresh
  `ORCH_HOME`, `ORCH_GH_SHIM` and `ORCH_GH_SHIM_STATE` and unset the outer session's `ORCH_*` and
  Claude variables, so the inner controller never saw the outer job, lease or lock; `orch status
--json` showed `state: idle` in each temp home before the first run.
- Each disposable repository `val-sN` has a bare `origin.git` beside it. Its remote is
  `git@github.com:orch-validation/val-sN.git`, rewritten to the bare repository with
  `url.<bare>.insteadOf` (the same mechanism as `makeRepoWithOrigin` in `tests/helpers.ts`).
  Its `main` holds `README.md` and a `factory.json` whose only check is
  `node -e "require('fs').accessSync('README.md')"`. Merging was enabled only in the temp home
  (`orch factory config merge enable --repo <repo>`), and the tickets were trivial (add one
  one-line file).
- **Real-store baseline, taken before the first run** (`orch ticket list --json` at
  2026-11-24T10:06Z): `total: 133`, ids **1 to 133**, with no gaps. After the runs, exactly two
  tickets were added: [0134](#tickets-filed) and [0135](#tickets-filed). Both are cited below.
  Nothing else in the real store was written.

### The GitHub stand-in

A copy of the stateful shim that `ghShim` in `tests/helpers.ts` writes, run through
`ORCH_GH_SHIM`. It was written to `…\orch0099\gh-shim.cjs`, copied into each scenario's `gh\`
directory, and never committed. Its PR heads come from the bare `origin` (`state.bare`), as in the
tests. Three additions are specific to this validation:

- **S1**: `check-runs` returns one check, `check`, `in_progress`, until the temp store holds a
  `job.released` event newer than the job's first `ci.observed` event (that is, until the session
  has released the job in `ci`). From then on it returns `completed`/`success`. The shim reads
  this from the temp `orch.sqlite`, read-only. In S2 and S3 the check is `success` at once.
- **S2**: PR #1 reports `mergeable: CONFLICTING` once its job is `completed`. On the first such
  answer, the shim pushes a real conflicting commit to `origin`'s `main` from a separate clone.
- Every call is appended to `gh\calls.log` with a timestamp and the caller's PID, so the
  session's reads can be told apart from the controller's.

`gh pr merge` only marks the PR `MERGED` with the merge commit `cccc…`. It does not merge anything
into the bare `main`, which is why `origin`'s `main` stays at its first commit (S2: at the
conflicting commit) in every scenario.

## S1: controller-side CI polling

**Tier: real-with-stand-in-GitHub.** The stand-in is the shim above, in mode S1.

**Setup.** `ORCH_HOME=C:\Users\Jon\AppData\Local\Temp\orch0099\s1\home` and the repository
`…\s1\val-s1`, with ticket 0001 "Add hello.txt containing exactly the line: Hello from S1".

**Commands.**

```sh
node setup.cjs s1 val-s1 S1 "Add hello.txt containing exactly the line: Hello from S1"
source s1/env.sh
orch do 1 --fast        # 10:07:46Z to 11:06:35Z, exit 0
```

**Outcome.** The run passed. Job `job-456ce246` (fast) built `hello.txt` and opened draft PR #1 at
head `44eb493`. The session then polled CI itself. It observed `pending` 20 times (polls 1 to 20,
`ci.observed` events up to id 38 at 11:02:05Z, with waits of 60, 120, 180 and 240 s as
`waitSeconds` gives them). On the next `orch factory next`, `plan.ci.release` was true, and the
session ran `orch job release` and exited 0. The controller then read CI itself and merged:

```text
  ci: complete: required check(s) passed: check
  merge: merged: https://github.com/orch-validation/val-s1/pull/1 is merged into main at 44eb493 (merge commit ccccccc). Ticket 0001 is done.
tickets   1 attempted, 1 verified and completed, 0 blocked
```

**Evidence** (`orch job events job-456ce246 --json`):

| id  | time (Z) | type             | payload (excerpt)                                                                                     |
| --- | -------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| 38  | 11:02:05 | `ci.observed`    | `ciStatus: pending, polls: 20, checks: [check in_progress]`, recorded by the session                  |
| 39  | 11:06:21 | `job.released`   | `session: orch-runner` (the session's `orch job release`)                                             |
| 41  | 11:06:32 | `runner.session` | `outcome: exited, exitCode: 0, pid: 165444, seconds: 3523, moved: true, stage: ci, status: running`   |
| 44  | 11:06:34 | `ci.observed`    | `ciStatus: passing, polls: 21, head: 44eb493…`, the **controller's** `reconcileCi`, after the release |
| 46  | 11:06:34 | `job.completed`  | `prUrl: …/val-s1/pull/1, head: 44eb493…`                                                              |
| 49  | 11:06:35 | `pr.merged`      | `verified: true, verifiedHead: 44eb493…, mergeCommit: cccc…, ticketId: 1`                             |

`gh\calls.log` shows that the reads from 11:06:33Z onward (the `check-runs` read, `pr ready`,
`pr merge --match-head-commit 44eb493…`) all came from one parent PID (157096): the controller
process, not a shell of the session. Afterwards, `orch ticket list` showed `0001 done`.

**Observation.** The session sleeps through one more wait (240 s) after its 20th pending
observation, before `orch factory next` tells it to release, so a pending CI keeps the session
alive for about 55 minutes before the controller takes over. This is the configured budget
(`CI_MAX_SESSION_POLLS = 20`), not a defect.

## S2: merge-conflict re-land

**Tier: real-with-stand-in-GitHub.** The stand-in is the shim above, in mode S2. GitHub's
`CONFLICTING` is the stand-in's answer. **A real Git conflict was produced:** the shim pushed
`2bba725 conflicting change on main` (`hello.txt` = `Hello from main`) to `origin`'s `main`, and
`git merge-tree --write-tree main <job A branch>` reports
`CONFLICT (add/add): Merge conflict in hello.txt`. The re-land session never had to resolve that
conflict, though: see defect [0135](#tickets-filed).

**Setup.** `ORCH_HOME=…\orch0099\s2\home` and the repository `…\s2\val-s2`, with ticket 0001 "Add
hello.txt containing exactly the line: Hello from the ticket".

**Commands.**

```sh
node setup.cjs s2 val-s2 S2 "Add hello.txt containing exactly the line: Hello from the ticket"
source s2/env.sh
orch do 1 --fast        # 10:07:46Z to 10:18:55Z, exit 0
```

**Outcome.** The run passed. The controller log, with tool lines left out:

```text
  merge: reland: GitHub reports the PR CONFLICTING with main. Created job-8a8eeca8 to re-land the work; job-24805fea is superseded and its PR must not merge. …
  merge: merged: https://github.com/orch-validation/val-s2/pull/2 is merged into main at 52f71d7 (merge commit ccccccc). Ticket 0001 is done.
tickets   1 attempted, 1 verified and completed, 0 blocked
```

**Evidence.**

| Job            | Mode | Final state                                 | PR                               | Key events                                                                                                                                                                                                                                    |
| -------------- | ---- | ------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-24805fea` | fast | completed, **superseded by `job-8a8eeca8`** | #1, open (`ready`), never merged | `job.completed` (head `5b2c077`), `runner.session` (`exited`, pid 45528, 175 s), `job.superseded {by: job-8a8eeca8}` at 10:10:45Z                                                                                                             |
| `job-8a8eeca8` | full | completed                                   | #2, merged                       | `job.created` `(re-land)`, `integration.completed {fromHead: 16f25f1, status: merged, conflicts: []}`, `job.completed` (head `52f71d7`), `runner.session` (`exited`, pid 169396, 487 s), `pr.merged {verified: true, verifiedHead: 52f71d7…}` |

`gh\calls.log`: the session's last `pr view` (10:10:33Z) was the first read to see `CONFLICTING`,
and it triggered the push at 10:10:34Z. The controller's `mergeJob` reads at 10:10:44Z (one
parent PID, 168376) saw `CONFLICTING` and created the re-land. Afterwards, `orch ticket list`
showed `0001 done`.

**Defect, reproduced once, filed as [0135](#tickets-filed):** the re-land does not start from the
superseded branch. `relandJob` asks the session in prose to "start from that branch's changes,
resolve the conflicts", but job B's worktree was created from the base `16f25f1`. Integrating
`main` was therefore a clean merge with no conflicts, and the builder wrote `hello.txt` again from
the ticket. `5b2c077` (job A's commit) is not an ancestor of the merged head `52f71d7`. The result
is correct for this ticket, but the reviewed work was redone, not re-landed.
Fixed by ticket 0135: a re-land's branch now starts at the superseded job's branch head, and its
builder merges `main` (decision 2026-11-24-reland-starts-from-the-superseded-branch).

## S3: stop and resume during real Claude execution

**Tier: real-with-stand-in-GitHub.** The stand-in is the shim above, with CI `success` at once.
The stop, the kill and the resume ran for real. GitHub only takes part in the merges.

**Setup.** `ORCH_HOME=…\orch0099\s3\home` and the repository `…\s3\val-s3`, with two ready
tickets: 0001 "Add a.txt containing exactly the line: first ticket" and 0002 "Add b.txt containing
exactly the line: second ticket". Both are full jobs (`orch start` creates full jobs).

**Commands.**

```sh
node setup.cjs s3 val-s3 S3 "Add a.txt …: first ticket" "Add b.txt …: second ticket"
source s3/env.sh
orch start              # run 1, 10:08:24Z to 10:16:17Z, exit 0
orch stop next          # 10:08:59Z, while run 1's child (pid 158412) was in spec
orch start              # run 2, 10:18:47Z, exit 0 after the stop
orch stop               # 10:21:11Z, while run 2's child (pid 1756) was in build
orch resume             # 10:22:15Z to 10:28:40Z, exit 0
```

**Outcome, `stop next` boundary.** This step passed. `orch stop next` printed "The controller
finishes its current ticket (re-land included), then exits." `orch status --json` then showed
`stop: {next: true}` with the child alive in `spec`. Ticket 0001 ran to its merge
(`job-d2f04ff8`, `pr.merged {verified: true}`), and the controller ended there:

```text
  ticket 0001: done: merged and verified (job job-d2f04ff8)
Session ended: stopped after the current ticket (orch stop next)
tickets   1 attempted, 1 verified and completed, 0 blocked
```

Afterwards, `orch factory list` held only `job-d2f04ff8`, and `orch ticket list` showed
`0001 done` and `0002 open`. No job was created for 0002. The request was consumed: run 2's status
showed `stop: {next: false}`.

**Outcome, `orch stop` during the child.** This step passed. Run 2 dispatched `job-031bb6ec` for 0002. Two minutes later, while the builder
agent was starting, `Get-CimInstance Win32_Process` showed the child `claude.exe` (pid 1756, parent
controller 168800) plus 6 descendants, including the `node` Playwright MCP server started by
`npx`. `orch stop` printed "The controller stopped. Its job is kept as it was; orch resume
continues the session." Run 2 ended with `0002 stopped: stopped on request; the job is kept as it
is`, `next: orch resume`. Fifteen seconds later, `Get-Process` found **none** of the child, its 6
descendants, or the controller alive: the Windows sweep removed the whole tree.
`orch status --json` reported `state: interrupted`, `current: {ticket: 0002, job: job-031bb6ec,
stage: build, status: running, childPid: null, childAlive: false}`, and `next: orch resume
continues the session`. `orch job show job-031bb6ec --json` showed `stage: build`,
`status: running`, `ownerSession: null`, no token and no lease: the job was kept and released, and
it was **not cancelled** (it has no `job.cancelled` event).

Events on `job-031bb6ec` from the stop:

| id  | time (Z) | type             | payload (excerpt)                                                                                                        |
| --- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 59  | 10:21:15 | `runner.session` | `outcome: stopped, exitCode: null, signal: SIGTERM, pid: 1756, seconds: 146, moved: true, stage: build, status: running` |
| 60  | 10:21:15 | `job.released`   | `session: orch-runner`                                                                                                   |

**No `runner.stopped` event was written, as designed:** decision
[2026-11-21-runner-evidence-on-the-job](decisions/2026-11-21-runner-evidence-on-the-job.md) says
"A stop on request records the ended session and no stop", so the stop is the `runner.session`
event with `outcome: stopped`.

**Outcome, `orch resume`.** This step passed. The resumed run kept the same session (`runner.json`
`startedAt` 10:18:47.802Z, `mode: queue`, `repo: null`) and continued the same job:

```text
ticket 0002 [github.com/orch-validation/val-s3] Add b.txt containing exactly the line: second ticket
  job job-031bb6ec: found in build/running
  claude: started (pid 129572) in …\worktrees\github.com-orch-validation-val-s3\job-031bb6ec
  claude: exited (code 0); job is completed/completed
  merge: merged: https://github.com/orch-validation/val-s3/pull/2 is merged into main at 43f894d (merge commit ccccccc). Ticket 0002 is done.
  ticket 0002: done: merged and verified (job job-031bb6ec)
Session ended: no ready ticket is left
```

The new child claimed the same job (`job.claimed` at 10:22:16Z, then the skill's renewal) and
rebuilt from `build`. Events 96 `runner.session {outcome: exited, pid: 129572, seconds: 382}` and
99 `pr.merged {verified: true, verifiedHead: 43f894d…, ticketId: 2}` followed. At the end,
`orch ticket list` showed `0001 done` and `0002 done`, both jobs were `completed` with merged PRs,
and `orch status` showed `idle`.

## S4: POSIX process-group termination

**Tier: untested.** It was not run. The only host was Windows, where the controller ends the child
and then sweeps its descendants by parent id. The POSIX path (`kill(-pgid)` on the child's process
group) does not run there. WSL 2 with Ubuntu is installed on this machine, but it has no `node` and
no `claude` (`wsl -d Ubuntu -e sh -c 'command -v node; command -v claude'` found only `git`), and
nothing was to be installed for this validation. The run is handed to [0134](#tickets-filed).

## Not validated

- **S4, POSIX process-group kill:** no POSIX host with Node and Claude was available, and nothing
  was installed. Deferred to [0134](#tickets-filed).
- **S1 against real GitHub:** real check timing, a real workflow that stays pending, and the real
  `check-runs` API. Creating a GitHub repository, PRs and workflow runs is an outward-facing action
  a person must approve. Deferred to [0134](#tickets-filed).
- **S2 against real GitHub:** GitHub's own mergeability computation, and a real `gh pr merge`
  that updates `main`. The same reason applies. Deferred to [0134](#tickets-filed).
- **Ctrl+C on the controller, and a dead controller's live child** (the `orch resume` refusal and
  `--force`) were not part of these scenarios. They are covered by `tests/run.test.ts` with
  stand-ins only.

Ticket 0099's checklist, accounted for: controller-side CI polling, the re-land, and stop/resume
were done with the stand-in GitHub (S1 to S3). The real-GitHub part of S1 and S2 is
`deferred to 0134`, and the POSIX process-group box is `deferred to 0134`.

## Defects found

- [0135](#tickets-filed): a re-land job starts from the base, not from the superseded branch, so
  its session re-implements the change instead of resolving the conflict (S2).

No other defect was observed. Every scenario that ran reached the outcome its decision describes.

## Tickets filed

Both tickets were filed in the real store with `orch ticket add`, related to 0099. These are the
only writes to the real store.

| Id   | Type  | Title                                                                                                                         |
| ---- | ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0134 | chore | Run the controller recovery paths 0099 could not: POSIX group kill, real-GitHub CI polling and re-land                        |
| 0135 | bug   | A re-land job starts from the base, not the superseded branch, so its session re-implements instead of resolving the conflict |
