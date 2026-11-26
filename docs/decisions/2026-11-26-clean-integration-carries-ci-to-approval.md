# A clean base integration carries the CI pass to review and approval

**Decision.** Under `verification.authority: "ci"`, review and approve complete only for a commit
GitHub CI passed (`requireCiPassed` in `src/ops/gates.ts`). That gate now also accepts HEAD when
the pure rule `ciCarriesThroughIntegration` in `src/core/workflow.ts` holds: `ciStatus` is
`passing`, and HEAD is the `resultHead` of exactly one `integrations` row with status `merged`,
`fromHead` equal to `ciHead`, and empty `material` (no edits inside the merge commit,
`git diff-tree --cc`), with nothing but `up-to-date` rows after it. Nothing else changes: no stage,
transition, counter, or schema change, and `integrateBase` behaves as before.

**What still needs CI on the exact head.** Everything after approval. Approve leads to `pr`, which
pushes the merge commit; `ci` completes only on a verdict GitHub gave for that exact head
(`requireDeliverable`, `completeCi`), and `mergeDecision` merges only `ciHead`. So the carry lets
reviewers and the approver judge a merge commit CI has not run on (local fast checks still must
pass for it, `requireVerified`), but nothing is delivered, marked completed, or merged without CI
passing on the merged head. A failure there takes the existing repair path (`maxCiRepairs`).

**Bound.** One clean integration per CI pass. If the base moves again before CI re-ran, HEAD is two
integrations from `ciHead`, no single row links them, and the gate refuses with the old message: a
person runs `orch factory resume <job> --to pr`. The count is derived from `integrations` rows,
never from events. It cannot loop: approve completes once per review cycle, and base moves after
completion stay bounded by `MAX_BASE_REOPENS`
([2026-11-24-merge-requires-current-base](2026-11-24-merge-requires-current-base.md)).

**Unchanged.** A merge with edits inside it is new code and reworks to build. A conflict reworks
(approve, pr, ci) or throws. A merge made by hand has no `integrations` row and is not carried. A
clean integration in the `ci` stage still reworks. `local` authority and fast jobs never reach this
gate.

**Why.** A clean merge of the base is mechanical: its content is the reviewed head plus commits
that already passed the base's own checks. Before this, every base move during review or approve in
a `ci`-authority repository ended in `needs-human`, because the only way to get CI for the merge
commit before approval was a person's `resume --to pr`; job-f6b197cf (ticket 0162) waited a night
for that click with every reviewer passing. The pass a person started is the same pr/ci pass that
follows approval anyway, so only the click goes away; the evidence does not. Running a pr/ci pass
before approval instead (approve → pr → ci → approve) would need a new transition and stage
machinery for the same evidence one stage earlier, so it was not chosen.
