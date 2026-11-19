# A merged PR completes a ci-stage job

**Decision.** When `orch gh ci` (or `orch gh pr status --token` on a running ci job) reads the
job's own PR as `MERGED` with its head equal to the worktree HEAD, it decides that first, before
any re-run, rework, or escalation and whatever the checks say. It evaluates the delivery gate
(`requireDeliverable`: clean tree, approved HEAD, verified HEAD, authorized policy) for that head.
If the gate holds, the job completes in the same call through `completeCi`, which passes an explicit
`mergedByHuman` flag to the pure `ci` complete rule; that rule then requires `prState: merged` and a
`ciHead`, accepts any `ciStatus`, and records `mergedByHuman` and "merged by a human before CI
finished" on `job.completed` (`completionOf` gives `merged`). A merge with passing checks completes
as a normal verdict. If the gate refuses, the job escalates with both facts in the reason. A
foreign PR or a merge of another head keeps the `outdated` escalation and accept-delivery.
`orch worktree remove` without a token then removes a finished, merged job's worktree in a short
`session` episode under the dashboard's `cannotRemoveWorktree` rule.

**Why.** PR #84 was merged by hand while its checks ran; the job stayed "CI pending" and could
only be cancelled, recording delivered work as `cancelled`. Decision 53 makes GitHub's verdict the
only completion so that nothing unverified is called delivered. A human merge of the exact commit
orch verified and the approver approved is a stronger human decision than accept-delivery, and the
same evidence that would have let `orch gh ci` complete is still checked. What it does not have is
a passing CI verdict, so the record says so and the board never shows it as one.

**Limits.** The flag is never inferred from a stored `prState`: a stale `pr status` record cannot
complete a job, and `orch job transition complete` stays refused in `ci`. `origin/<branch>` is not
compared, because GitHub may delete the merged branch. The dashboard's Refresh PR still only
records the merge on an escalated job; accept-delivery stays the explicit close-out there.
