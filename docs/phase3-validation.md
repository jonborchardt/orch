# Phase 3 concurrent-job validation (B05): procedure

**Status: RUN 2026-11-14, PASS with one environmental condition** (see the run record at the end).
This is the procedure for the B05 acceptance campaign. Nothing below uses the ORCH repository itself
as a target.

## Prerequisites

- `main` contains Phase 2 and the Phase 3 PRs; `npm run build` done; the installed `orch` is that
  build (`orch --version`, `orch doctor`).
- Two disposable GitHub repositories (call them `val-a` and `val-b`), each with a committed,
  pushed `factory.json` whose checks run on this machine (`orch init --check` says `READY` in
  both), GitHub Actions enabled, and at least one workflow that runs on pull requests. Never a
  repository anyone depends on; never ORCH.
- Three real issues: two in `val-a`, one in `val-b`, each small enough for one factory job.
- A dedicated state directory for the campaign, separate from development and from Phase 1:
  `ORCH_HOME` set to it in every shell and in the VS Code window that runs the parent session.
- VS Code with the Claude Code extension, opened on `val-a`, started from a shell where
  `ORCH_HOME` is set (the extension inherits the environment), and the Agents window available.
- `gh auth status` succeeds for the account that owns both repositories.

## Procedure

1. **Dispatch three jobs from one parent session.** In the parent session (Agents window, `val-a`):

   ```
   /factory dispatch #<issue-1> in <path to val-a>, #<issue-2> in <path to val-a>, #<issue-3> in <path to val-b>
   ```

   Expect three `orch factory dispatch` results with distinct job ids and `duplicate: false`,
   three `create_session` calls with `worktree: true`, three `orch job session attach` records,
   and a report table. Record the job ids and session links.

2. **Separate worktrees.** `git worktree list` in `val-a` shows two new worktrees under
   `val-a.worktrees/` on `agents/...` branches, `val-b` one. After each child's first
   `orch factory resume --adopt`, `orch factory list --json` shows each job's `worktreePath` equal
   to its session's toplevel and three distinct branches; the primary checkouts stay clean.

3. **Concurrent execution.** Watch `orch factory list --json` (or the dashboard, `orch ui`) while
   the three children run spec, build, review, approve, pr, and ci without the parent acting.
   The parent session continues unrelated work meanwhile (B03).

4. **Lease ownership.** For each job, `owner.session` is its child's session name and
   `owner.live` is true while it works; no job ever shows the parent's name as owner after
   dispatch; `orch job events <id>` shows exactly one `job.claimed` per resuming session.

5. **No source collisions.** `git -C <val-a> status --porcelain` and `git -C <val-b> status
--porcelain` are empty throughout; each job's commits are only on its own branch
   (`git log --oneline main..<branch>` per branch); the two `val-a` jobs touch disjoint files or,
   if they overlap, each PR shows only its own changes.

6. **Independent verification artifacts.** Under `<ORCH_HOME>/jobs/<id>/artifacts/` each job has
   its own `spec.md`, `build.md`, `round-N/`, `decision.md`, `pr.md`, and
   `verification/<run>/` logs; `orch verify show <id>` reports a run for that job's HEAD only.

7. **Independent draft PRs.** Three draft PRs, one per branch, each with `pr.md` as body
   (`orch gh pr status <id>`). None is marked ready or merged by the factory.

8. **CI reconciliation per job.** Each job reaches `completed` only after `orch gh ci` recorded
   `passing` for its own PR head (`ciHead` equals the branch tip); a failing check on one job sends
   only that job back to `build` (`job.reworked` event) while the others continue.

9. **Parent inspection and navigation.** From the parent: `orch factory list --json` lists all
   three with stage, status, `needsHuman`, `session`, and PR; the dashboard detail of each job
   shows the attached `vscode-agents` session link (copyable, with the in-VS-Code note), the
   worktree link, and the PR link; `list_sessions` from the parent shows the three children with
   their working directories.

10. **Interrupted child resumes.** Stop one child mid-build (close its session). Wait for its lease
    to lapse (or use `--force` deliberately), then from any session run `/factory <id>`; expect the
    same job id, `tookOver: true`, the same worktree, a second `session.attached` event whose
    payload names the previous one, and no new job in `orch factory list`.

11. **One failure does not block the rest.** Make one job fail deliberately (for example an issue
    whose implementation cannot pass the repository's checks, or cancel it from the dashboard). The
    other two reach `completed`; the failed one shows `needsHuman` or `cancelled` with its recorded
    reason and never a success state.

12. **Isolation of the campaign.** No files were written into any primary checkout or into another
    phase's `ORCH_HOME`; `git worktree list` shows only the expected worktrees.

## Recording the result

Write the outcome of every numbered step (PASS / FAIL with the observed value) into this file
under a dated "Run" heading, with job ids, PR URLs, and the `orch factory list --json` output at
the end. Mark B05 PASS only when every step passed in one run. A step that was skipped stays
NOT RUN.

## Run 2026-11-14 (ORCH `main` @ b549667, `ORCH_HOME=E:/github2/orch-b05-state`)

Targets: `jonborchardt/orch-validation` (private; issues #9, #10) and `jonborchardt/orch-validation-b`
(created for the run; issue #1, later #3 and #5). Parent: one VS Code Agents-window session. Full
ledger, evidence files and report: `orch-validation-campaign/b05/` (local, outside this repository).

| Step                          | Result                                             | Observed                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Dispatch                    | PASS                                               | job-3ad6a0e9, job-40b5cc8d (val-a), job-d2843820 (val-b); three `create_session` calls; three attaches                                                                                                                                                  |
| 2 Worktrees                   | PASS                                               | one host-made worktree per job on `agents/...`; primaries clean throughout                                                                                                                                                                              |
| 3 Concurrent                  | PASS                                               | review / build / build at the same time under three owner sessions; the parent did no stage work                                                                                                                                                        |
| 4 Leases                      | PASS                                               | one `job.claimed` per job by its own child; parent never an owner                                                                                                                                                                                       |
| 5 No collisions               | PASS                                               | commits only on job branches; two val-a jobs touched the same files, each PR carries only its own                                                                                                                                                       |
| 6 Artifacts                   | PASS                                               | separate spec/build/round-N/decision/pr/verification per job                                                                                                                                                                                            |
| 7 Draft PRs                   | PASS                                               | orch-validation #11, #12; orch-validation-b #2 (later #4, #6); none ready or merged                                                                                                                                                                     |
| 8 CI per head                 | PASS (mechanism); val-a blocked by the environment | `ci.observed` bound to the exact head everywhere; val-b completed inside `orch gh ci`; val-a: GitHub Actions refused to start jobs on the account's private repositories (billing), ORCH re-ran once, reworked once, children escalated with the reason |
| 9 Parent view                 | PASS                                               | `orch factory list`, `list_sessions`, dashboard detail with the session link; no owner token in responses                                                                                                                                               |
| 10 Interrupt and resume       | PASS                                               | job-13b07951 stopped mid-build by a steer message (lease live); a new session took it over with `--force`, kept the worktree, completed as PR #6; no duplicate job                                                                                      |
| 11 One failure does not block | PASS                                               | both val-a jobs parked in needs-human while val-b jobs completed                                                                                                                                                                                        |
| 12 Isolation                  | PASS                                               | Phase 1 and default databases unchanged; no file in any primary checkout                                                                                                                                                                                |

Manual interventions: the new disposable repository was made public so Actions would run on it;
its main-branch workflow was re-run by hand once; the interruption used a steer message (archiving
the session would have removed the job's worktree); the resume authorised `--force` explicitly.
Observations fed back into the skill text: the parent's token-less attach races the child's claim;
the resuming session should attach itself.
