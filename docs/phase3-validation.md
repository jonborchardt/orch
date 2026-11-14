# Phase 3 concurrent-job validation (B05): procedure

**Status: NOT RUN.** This is the prepared procedure for the B05 acceptance campaign. It must not
run until the Phase 1 validation campaign has finished and the Phase 2 reliability changes
(concurrent checkout protection, Windows process-tree termination, shared test-resource isolation,
CI-stage dashboard and recovery) are merged and installed. Nothing below uses the ORCH repository
itself as a target.

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
