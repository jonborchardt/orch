# A foreground controller may start its own Claude sessions

Supersedes, for this one case only, the clause of decision 51 that rejected spawning `claude` from
`orch`, and the "what is not built" lists that named `orch start`, `orch do`, and `orch stop next`.
The recovery worker and the dashboard are unchanged: neither starts or messages a session.

**Decision.** `orch start [repo]`, `orch do <ticket>`, and `orch resume` run one foreground
controller (`src/ops/run.ts`). While that command runs, and only then, it takes the best ready
ticket (`listTickets` view `ready`), creates its job through `dispatchJob` (the ticket claim is the
job insert), starts the existing `/factory` skill for the job as a headless child
(`claude -p "/factory <job>"`, `src/integrations/claude-session.ts`, the only place a Claude
process is started), reads the job row when the child exits, reads CI itself when no agent is
needed (`reconcileCi`, as the recovery worker does), merges through `mergeJob`, and goes on. It
implements no stage and skips no gate: everything a job does still goes through the skill and the
same `orch` commands.

What the exception does not allow: a detached or scheduled controller, a controller started by
the dashboard or by another command, messaging or re-attaching to a session, more than one ticket
at a time, or supervising any process other than the one child it started.

- **Outcome levels are kept apart.** The child's exit code is logged and otherwise ignored. A job
  is finished when its row says so; a ticket is done only when `mergeJob` reports a merge of the
  CI-verified head (`verified`) and the ticket lifecycle closed it. A merged but unverified PR, or
  a merged ticket with unchecked boxes, ends the ticket as blocked.
- **One function decides, from durable state.** `runTicket` looks at the ticket's jobs first: an
  unfinished job is continued, a completed one is merged, a cancelled one is never replaced, a
  ticket that is `open` (new, or reopened by a person) gets a job. So `orch do` twice, or
  `orch resume` after any crash, repeats nothing: no table of in-flight steps exists.
- **The queue stops at the first ticket it could not finish** (blocked, needs a person, a budget
  spent) and reports it. Tickets of a repository without the merge opt-in are reported and passed
  over without being started; a lost claim race is passed over too.
- **Budgets, all small and fixed:** a session that exits twice running without moving the job
  (stage, round, CI repairs, artifacts) stops the ticket; 60 CI observations by the controller;
  five attempts at an unreadable GitHub or an undecided mergeability. Rework and re-land stay
  bounded by `maxRounds`, `maxCiRepairs`, and `mergeJob`'s single re-land. Nothing judges a quiet
  session stalled: only the process ending ends the wait.
- **Ownership.** The controller and its child use one fixed session name, `orch-runner`. The
  controller claims the job and makes the worktree before starting the child there; the child's own
  `orch factory resume` is then a renewal, and after a crash the next controller renews the same
  lease without `--force`. Whenever the controller gives a job up unfinished it releases it, so a
  person's `/factory <job>` can take it at once.
- **State outside the database** is four files in the data directory, one writer each
  (`src/ops/runner-state.ts`): `runner.lock` (the live controller; created with `wx`, so two
  starts cannot both hold it; stale when its PID is gone, predates the boot, or stopped beating),
  `runner.json` (the session's intent: mode, repository scope, explicit ticket, the ticket, job,
  and child PID in flight, results; replaced by rename), and `runner.stop-next` /
  `runner.stop-now` (written only by `orch stop`). A heartbeat therefore cannot erase a stop
  request, and the record never repeats a job's stage or a ticket's status.
- **Stopping.** `orch stop next` leaves a request the controller reads at the ticket boundary; it
  survives an interruption and `orch resume` honours it. `orch stop` (and Ctrl+C) ends the child
  the controller itself started (the process group on POSIX; on Windows the process, then its
  descendants by parent id), releases the job as it is, and leaves the session resumable. Nothing
  is cancelled. Git or verification work the child was in the middle of is covered by what already
  covers a dead session: the verify lock is swept by PID and a base integration is reconciled on
  the next call.
- **A dead controller's child.** The record holds the child's PID. If that PID is alive,
  `orch resume` refuses, and `orch stop` refuses to discard the session: `orch` never signals a
  PID it only read from a file, and never starts a second agent on a job. `orch resume --force` is
  a person saying the PID belongs to something else now.
- **Permissions.** The child gets `--permission-mode auto` and an allow-list for the shell
  commands the skill and its builder run (`orch`, `git`, `npm`, `npx`, `node`, `cd`), never a
  bypass. A repository that needs more sets `runnerClaudeArgs` in the user's `factory.json`.

**Why.** The pieces existed (a global queue with an atomic claim, a resumable job, a verified
merge), but joining them was a person typing `/dotodo` per ticket. A foreground process the user
starts and can see is the smallest thing that removes that step while keeping the reasons for
decision 51: there is still no invisible session, since the controller prints what it starts and
`orch status` names the child, and still no supervisor, since everything ends with the command.

**Limits.** Only the launch itself was exercised against the real `claude` (2.1.323, Windows): a
complete unattended `/factory` run under the default permission arguments is not covered by the
suite, which replaces the child. A Claude installed as a `.cmd` shim is refused, because the prompt
cannot be passed through `cmd.exe` safely. The child-alive check knows only a PID and the boot
time; a reused PID reads as alive until `--force`.
