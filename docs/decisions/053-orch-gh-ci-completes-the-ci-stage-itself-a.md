# 53. `orch gh ci` completes the ci stage itself; a stored verdict never does

**Observed (Phase 1 acceptance closure).** After decision 52 a resumed session could still complete
`ci` on a stored `orch gh ci` verdict for the current HEAD without reading GitHub again. The verdict
was genuine for that commit, but completion is a claim about the PR, and between the read and the
completion the PR can be closed, its head can move (a push from outside the job), or a check can be
rerun for the same commit and fail. `reconcileCi` detects all three; the stored-verdict path skipped
it. The gate also had no way to tell a stored verdict from a fresh one without a timestamp
heuristic.

**Decision.** The read and the completion are one operation. `reconcileCi` calls `completeCi`
(`ops/gates.ts`: clean tree, `ciHead` equals HEAD, valid verification run, authorized policy, then
the pure transition) in the same call that evaluated GitHub's checks for the PR head, and
`transitionGuarded` refuses `complete` in the `ci` stage outright, so the CLI, the plan, and a
resumed session have exactly one way to finish: run `orch gh ci`, which reads first. The plan for
`ci` therefore always lists `orch gh ci`; a recorded passing verdict is mentioned as something to
confirm, not reuse. Skipped-only check runs are now `none` even when a human made the checks
required (GitHub's merge button would count them): the factory does not infer success from a check
that did not run, and the human close-out (`resume --to completed`, recorded `acceptedByHuman`)
remains the explicit, distinguishable exception. The normal flow makes no extra API call (the
passing read already happened); only a resumed session with a stored verdict pays one read, which is
the read it was missing. Rejected: a freshness window on `ciCheckedAt` (a timer standing in for a
fact that is cheap to re-read), and re-reading GitHub inside `orch job transition complete` (a
"transition" that calls the network and can rework the job would surprise every caller).
