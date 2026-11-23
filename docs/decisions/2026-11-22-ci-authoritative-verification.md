# GitHub CI can be the authoritative test gate; CI then passes before review

**Decision.** `factory.json` takes one optional key, `verification.authority`: `local` (the default,
also when the key is absent) or `ci`. Under `ci` the policy's `commands` are the fast checks
(typecheck, lint, format, build) and `orch verify` runs only those; GitHub CI is the one full test
run. The stages are unchanged; their order under `ci` is spec → build → simplify → pr → ci →
review → approve → pr → ci → completed. `transition` takes the authority (and, for ci complete,
whether `requireApproved` holds for HEAD) from `ops/gates.ts`: simplify complete goes to pr, pr
complete skips the decision.md check, and a passing ci complete without an approval goes to review
(`stage.completed` with the head) instead of completing. Push, `pr create`, pr complete and that
ci complete use `deliveryGate`: `requireDeliverable` without the approval check while no approval
holds for HEAD (still clean, verified at HEAD, authorized policy, and in ci a verdict for HEAD).
Review and approve complete only while `ciStatus` is `passing` for `ciHead === HEAD`.
`reconcileCi` marks the PR ready only when the job `completeCi` returned is `completed`, so the
pre-review pass leaves a draft and the session's lease. `deliverableRefusal` still needs the
approval, so a human merge before review escalates. `canonicalPolicy` includes the authority only
when it is `ci`, so every existing fingerprint is byte-identical; `diffPolicy` reports an authority
change (local → ci counts as weakening), so a change needs the existing accept-policy.

**Why.** The full suite ran twice per ticket, locally and in CI. Making CI the gate removes the
local run, but tests are then proven only by CI, so CI must pass for the exact commit before
reviewers and the approver judge it; otherwise approval would bind to untested code. Reusing the pr
and ci stages twice needs no new stage, column, migration, or repair loop: failures go through the
existing `rework` and `maxCiRepairs`, and commit pinning invalidates everything after a new commit
with no new state. A `both` mode was not added, because `local` already runs CI at the end.

**Exception to decision 39.** Under `ci`, verified but unapproved commits reach a draft PR (the
pre-review pass). The PR stays a draft, nothing merges, and the ready write and completion still
need the approval of HEAD.

**Secrets before review.** The job branch lives in the repository itself, not a fork, so under `ci`
the pre-review pass runs the unreviewed branch's workflows and tests with the repository's Actions
secrets and its `GITHUB_TOKEN`; a changed workflow or test can read them before anyone has looked.
This is accepted because the branch is written by the user's own factory session, which already
runs on the user's machine with the user's Git and `gh` credentials, and because what it limits is
a merge: the PR stays a draft, and `workflow-changed` (decision
2026-11-22-workflow-changes-need-a-human-merge) keeps a workflow change from merging without a
human. It does not stop the changed workflow from running once. A repository whose `pull_request`
workflows carry secrets the session should not reach (deploy, publish, or cloud credentials) should
keep `local`, where CI runs only after review and approval.

**Left out.** ORCH's own opt-in (below), a third mode, changes to `maxCiRepairs`, the controller,
the dashboard, `orch init`, and `cannotAcceptDelivery`.

## Pending: ORCH opt-in

Not delivered by ticket 0115: the installed `orch` that gates a job is main's build, and its
`parsePolicy` rejects the unknown `verification.authority` key, so committing the opt-in on the
job branch would block approval and accept-policy. Follow-up ticket 0116 (job-7143c97f) carries it
out. Status: steps 1 to 5 are done (job-7143c97f); nothing here is pending any more.

1. Done: after the 0115 PR merged, `npm run build` on main, then `orch install`; the installed
   `parsePolicy` accepts `verification.authority`.
2. Done: committed by job-7143c97f (d378e0c) and accepted: ORCH's `factory.json` set to:

```json
{
  "verification": {
    "authority": "ci",
    "commands": [
      { "id": "typecheck", "command": "npm", "args": ["run", "typecheck"], "required": true },
      { "id": "lint", "command": "npm", "args": ["run", "lint"], "required": true },
      { "id": "format", "command": "npm", "args": ["run", "format:check"], "required": true },
      { "id": "build", "command": "npm", "args": ["run", "build"], "required": true }
    ]
  }
}
```

3. Done: a human accepted it for job-7143c97f with the dashboard's accept-policy.
4. Done: job-7143c97f, the first CI-authoritative ORCH ticket, recorded its measured whole-ticket
   verification time below, replacing the computed "after" figure.
5. Done: 0113 is reevaluated against it under "0113 reevaluation" below.

## Measurements

Recorded 2026-11-22 on the Windows development machine that runs the factory. Each figure is
labelled **measured** (read from a clock or a log) or **computed** (arithmetic on measured figures).

| Figure                                         | Value                 | Kind     | Source                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full local `npm run check` (the `check` step)  | 23 min 35 s           | measured | `orch verify` run 175 of job job-f3982f23 at 6846392, check `check` duration 1415038 ms (`verification/175/check.log`)                                                                                                                                                     |
| `npm run typecheck`                            | 30.5 s                | measured | timed separately in the job-f3982f23 worktree, 2026-11-22                                                                                                                                                                                                                  |
| `npm run lint`                                 | 67.2 s                | measured | same                                                                                                                                                                                                                                                                       |
| `npm run format:check`                         | 14.5 s                | measured | same                                                                                                                                                                                                                                                                       |
| `npm run build`                                | 11.1 s                | measured | same                                                                                                                                                                                                                                                                       |
| Fast checks together                           | 123.3 s (about 2 min) | computed | sum of the four rows above                                                                                                                                                                                                                                                 |
| GitHub CI wall-clock for a PR                  | 11 min 56 s           | measured | `gh run view 45002908723` (PR #115, ticket 0109, attempt 1): created 08:27:35Z, last job done 08:39:31Z; the slowest job, `windows (rest)`, ran 08:27:39Z-08:39:30Z                                                                                                        |
| Verification per ticket before (`local`)       | 35 min 31 s           | computed | full local check + CI wall-clock, one pass each (23:35 + 11:56)                                                                                                                                                                                                            |
| `orch verify` run 190 under `ci` (ticket 0116) | 2 min 9 s (128.7 s)   | measured | `orch verify show job-7143c97f --json`: run 190 at ebee472, policy source `authorized`, authority `ci`, passed; started 2026-11-23T02:19:53.593Z, completed 02:22:02.304Z; checks typecheck 31268 ms, lint 69875 ms, format 15500 ms, build 12006 ms (`verification/190/`) |
| GitHub CI run under `ci` (ticket 0116)         | 12 min 26 s           | measured | `gh run view 45100041089` (workflow CI, PR #121, ebee472, attempt 1, success): created 2026-11-23T02:24:41Z, last job done 02:37:07Z; the slowest job, `windows (rest)`, ran 02:24:44Z-02:37:07Z                                                                           |
| Verification per ticket after (`ci`)           | 14 min 35 s (874.7 s) | measured | job-7143c97f (ticket 0116): verify run 190 + CI run 45100041089 attempt 1 (2:09 + 12:26); 2 passes: one local verify run and one CI run attempt, no re-run attempts and no CI repairs                                                                                      |
| After compared with before                     | 59% less              | computed | 1 - 874.7 s / 2131 s (14:35 against 35:31); the earlier computed estimate was 13 min 59 s, about 61% less                                                                                                                                                                  |

The "after" row covers job-7143c97f up to the commit that records it. Excluded, and named as
excluded: runs under the baseline (`local`) policy before acceptance (there were none: round 1
stopped before `orch verify`, and `orch job events job-7143c97f` shows no `verification.started`
before `policy.authorized` at 2026-11-23T02:15:00Z; `gh run list` for the branch shows no CI run
for d378e0c); and this recording commit's own verify and CI passes and the delivery pass, which a
commit cannot contain and which go into the 0116 ticket note. One sample is noisy: a CI re-run
takes longer, for example `gh run view 45023401560` (PR #117, attempt 2) finished 25 min 10 s after
it was created. The ticket's own earlier sample (PR #112, about 21 min local and 10.5 min CI) is
cited from the ticket and was not re-measured here.

### 0113 reevaluation

Ticket 0113 targets "a completed PR in under 10 minutes, excluding external CI delays" for a
trivial change. Measured on job-7143c97f (`orch job show` / `orch job events`), from `job.created`
at 2026-11-23T00:25:10.830Z to the round-2 `stage.started` (build) at 02:40:58.373Z, where these
figures were read:

| Figure                                         | Value                  | Kind     |
| ---------------------------------------------- | ---------------------- | -------- |
| Job wall-clock to recording                    | 2 h 15 min 48 s        | measured |
| Waiting for a human (escalation to acceptance) | 1 h 37 min 4 s         | measured |
| Wall-clock without the human wait              | 38 min 44 s (2324.0 s) | computed |
| Verification share of that (874.7 s)           | 37.6%                  | computed |
| Local verify share (128.7 s)                   | 5.5%                   | computed |
| Without CI and the human wait                  | 26 min 18 s (1578.0 s) | computed |
| Stage and agent overhead (that minus verify)   | 24 min 9 s (1449.3 s)  | computed |

The human wait runs from `runner.stopped` (needs-human, accept-policy) at 00:37:56.829Z to
`policy.authorized` at 02:15:00.331Z. Verification is 10.7% of the full wall-clock.

What ci authority already addresses: 0113's "run relevant targeted checks rather than the entire
validation suite" for verification. The local run is now the fast checks only (2 min 9 s, within
the 10-minute budget), and the full suite runs once, in CI, which 0113 excludes as an external
delay. What remains is stage and agent overhead: about 24 minutes outside verification, CI and the
human wait, from separate spec, build, simplify, review, and approve sessions. That is 0113's
single-agent, minimal-pipeline part, and ci authority does nothing for it.

Recommendation: narrow 0113 to the single-agent fast pipeline (skip spec, simplify, and parallel
review); its verification goal is already met by `verification.authority: "ci"`.
