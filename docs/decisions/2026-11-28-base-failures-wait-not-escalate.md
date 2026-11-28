# A CI failure the base shares waits in ci; a mechanical re-run is never handed to a person

**Decision.** needs-human means a person must decide something only a person can (ticket 0228).
Before `reconcileCi` (`src/ops/github.ts`) reworks a failing head, reports it `exhausted`, or
escalates an `infrastructure` verdict that has culprit checks, it reads the base tip and compares
(`baseVerdict` in `src/core/ci.ts`, pure):

- **Base tip** is the commit GitHub reports for the job's base branch at read time
  (`gh api repos/{o}/{r}/commits/<base>`, `branchTip`), never the local `origin/<base>`. One
  reconciliation resolves it once: the base checks are read for that sha, containment is GitHub's
  compare of that sha against the head (`baseContains` given the sha), and that sha is what
  `ci.observed` records (`base: { branch, sha, verdict, checks }`).
- `failing` (every culprit has a current attempt on the base tip that completed without passing):
  outcome `base-failing`, action `wait`. Nothing is spent, no `job.blocked` or `job.reworked`.
  The session plan's only command is `orch job release`; the controller's `pollCi` returns at once
  with ticket code `base-failing`, which is not in `RUN_ENDING_CODES`, so the queue goes on and
  takes the ticket again after another ticket of the session ends `done`.
- `pending` (a culprit queued or running on the base): `wait` with the normal `waitSeconds`.
- `clear` (anything else, including a check the base never reports): after an earlier
  `base-failing` observation of this head, a head that does not contain the base tip reworks to
  build as a base integration (`integration: true`, no repair spent); one that contains it gets a
  second re-run when every culprit is re-runnable; a compare with no answer stays `base-failing`.
  Without such an observation a `failure`/`timed_out` reworks or exhausts exactly as before, and an
  `infrastructure` verdict gets a second re-run when every culprit is re-runnable.

**Two re-runs per head, ever** (`CI_RERUN_LIMIT`; the first, `CI_MAX_RERUNS`, is unchanged and
comes before any base read). A third verdict without a result escalates with "a human fixes CI,
then resumes --to ci"; no escalation reason asks a person to re-run a workflow.

**No wait was added.** No timer, poll, lock, table, column, or migration: the parked job is
released, unowned, visible as `waiting` on the dashboard ("Waiting for main to pass test; no person
needed"), cancellable, and continued by the existing `orch start`, `orch do`, the queue's retake,
or `orch factory resume`. A base that stays red parks the job indefinitely; escalating after N
observations was rejected as the false needs-human this removes. A flaky base whose latest run is
green by chance still reworks as before (accepted).

**Amends decision 58.** Decision 58 made a second failure of one commit a defect and a second
cancellation an escalation. A failure the base tip shares is now not the branch's defect, and a
second cancellation gets the second re-run. Decision 58's rejection of classifying flakes from logs
stands: the rule reads only GitHub's verdicts for two commits, never logs or run history.

**Audit of escalation paths** (what reaches needs-human, and whether this changed it):

| Path                                                         | Verdict | Why                                                                              |
| ------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------- |
| CI `infrastructure` after one re-run ("a human re-runs")     | changed | a second re-run is mechanical; only a third verdict escalates, asking for a fix  |
| CI failure shared with the base tip (rework, then exhausted) | changed | not the branch's defect: waits as `base-failing`                                 |
| PR closed without merging                                    | kept    | reopening or cancelling is a person's call                                       |
| Foreign or outdated PR head                                  | kept    | someone changed the branch outside the job                                       |
| Merged by a human but undeliverable                          | kept    | the delivery gate refused; only a person can accept it                           |
| No checks at all, or only skipped ones                       | kept    | the factory never invents success                                                |
| A required check that never reported                         | kept    | nothing to re-run; a workflow or protection setting is wrong                     |
| `action_required` or a commit status from another CI system  | kept    | cannot be re-run from here; after a green base it takes the usual path           |
| `maxCiRepairs` spent                                         | kept    | the budget exists so a person looks after repeated real failures                 |
| Review round limit, repeated scope gap                       | kept    | judgement calls                                                                  |
| Spec escalations and verification policy acceptance          | kept    | only a person accepts a spec or a policy                                         |
| The recovery worker's failure budget                         | kept    | unchanged; it sees `wait` for a parked job                                       |
| A session's manual `escalate` from `ci`                      | kept    | a free-text reason cannot be classified in code; the skill says not to use it so |

**Why.** A red base or a lost runner made the factory spend repair cycles on code that was not
broken, or stop for a person whose only possible action was a button GitHub offers anyway. Both
are now decided in TypeScript from GitHub's answers, and needs-human is left for real decisions.
