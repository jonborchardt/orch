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

**Left out.** ORCH's own opt-in (below), a third mode, changes to `maxCiRepairs`, the controller,
the dashboard, `orch init`, and `cannotAcceptDelivery`.

## Pending: ORCH opt-in

Not delivered by ticket 0115: the installed `orch` that gates a job is main's build, and its
`parsePolicy` rejects the unknown `verification.authority` key, so committing the opt-in on the
job branch would block approval and accept-policy. Follow-up ticket 0116 tracks it:

1. After the 0115 PR merges: `npm run build` on main, then `orch install`.
2. A change sets ORCH's `factory.json` to:

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

3. A human accepts it with the dashboard's accept-policy.
4. The first CI-authoritative ORCH ticket records its measured whole-ticket verification time
   below, replacing the computed "after" figure; then 0113 is reevaluated.

## Measurements

Recorded 2026-11-22 on the Windows development machine that runs the factory. Each figure is
labelled **measured** (read from a clock or a log) or **computed** (arithmetic on measured figures).

| Figure                                        | Value                 | Kind     | Source                                                                                                                                                              |
| --------------------------------------------- | --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full local `npm run check` (the `check` step) | 23 min 35 s           | measured | `orch verify` run 175 of job job-f3982f23 at 6846392, check `check` duration 1415038 ms (`verification/175/check.log`)                                              |
| `npm run typecheck`                           | 30.5 s                | measured | timed separately in the job-f3982f23 worktree, 2026-11-22                                                                                                           |
| `npm run lint`                                | 67.2 s                | measured | same                                                                                                                                                                |
| `npm run format:check`                        | 14.5 s                | measured | same                                                                                                                                                                |
| `npm run build`                               | 11.1 s                | measured | same                                                                                                                                                                |
| Fast checks together                          | 123.3 s (about 2 min) | computed | sum of the four rows above                                                                                                                                          |
| GitHub CI wall-clock for a PR                 | 11 min 56 s           | measured | `gh run view 45002908723` (PR #115, ticket 0109, attempt 1): created 08:27:35Z, last job done 08:39:31Z; the slowest job, `windows (rest)`, ran 08:27:39Z-08:39:30Z |
| Verification per ticket before (`local`)      | 35 min 31 s           | computed | full local check + CI wall-clock, one pass each (23:35 + 11:56)                                                                                                     |
| Verification per ticket after (`ci`)          | 13 min 59 s           | computed | fast checks + CI wall-clock (2:03 + 11:56), about 61% less; pending: a real measurement of the first CI-authoritative ORCH ticket under ticket 0116                 |

A CI run that needed a re-run takes longer: `gh run view 45023401560` (PR #117, attempt 2) finished
25 min 10 s after it was created. Under `ci` a typical ticket has two CI passes (pre-review and
delivery), but the delivery pass usually re-reads the same commit's verdict, so it costs a CI run
only when the base was integrated or a commit was added; that is why the "after" figure counts one
CI run and is computed, not measured. The ticket's own earlier sample (PR #112, about 21 min local
and 10.5 min CI) is cited from the ticket and was not re-measured here.
