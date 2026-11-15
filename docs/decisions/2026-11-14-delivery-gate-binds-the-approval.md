# The delivery gate binds the approval; a review round is the required reviewers on the built commit

**Observed (hardening investigation, `3653bcf`).** Decision 39 checked the approved commit only
in `orch gh push` and `orch gh pr create`. Completing `pr` and `ci` went through
`requireDeliverable`, which checked a clean, verified HEAD under an authorized policy but not the
approval. Seven reproductions reached `completed` with a HEAD the approver never saw, using only
supported commands and ordinary Git:

- an extra commit;
- a rewind;
- a divergence;
- an edited merge;
- a PR into another base registered with `orch job pr --url`;
- a plain `git push` during `ci`;
- a job resumed past `approve` that never had a `decision.md`.

Review rounds had three structural gaps:

- one PASS verdict completed a round;
- `--artifact` let one reviewer's verdict cite another reviewer's file;
- verdicts recorded against a commit made after `build.md` counted as a review of the build.

`maxRounds` compared the round number, which every build completion increments, so a CI repair or
a base-integration rework used up a review round that never rejected anything.

**Decision.**

- **The approval check lives inside `requireDeliverable`.** Push, PR creation, `pr` completion,
  and `ci` completion all call it, so what may leave the machine and what counts as delivered are
  the same predicate. The check is the one decision 39 described: `DECISION: APPROVE` with a head,
  HEAD contains it, and only clean base-integration merges follow it. `orch gh push` and `pr
create` keep only their pr-stage precondition.
- **`orch gh ci` escalates a foreign PR.** A PR whose head branch or base branch is not the job's
  is escalated as `outdated`.
- **`orch job pr` is removed.** `orch gh pr create` is the only thing that records a PR, and `orch
gh pr status` refreshes it.
- **Review completion requires the three always-on reviewers** (`ROLES` without `ui`) and verdicts
  for the commit `build.md` describes. A verdict is always read from `round-N/review-<reviewer>.md`.
- **`maxRounds` counts rejected rounds**: a `changes` verdict or `BLOCKING > 0`, derived from the
  rows already stored. No new counter is added, and a job whose history has no CI or integration
  rework escalates exactly as before.

**Rejected.**

- A second copy of the approval check in `completeCi`.
- A stronger approval artifact, such as a signed or "final head" field. Ancestry from
  `decision.head` already says what is needed.
- Requiring UI reviewers at the gate. UI detection belongs to the plan and can be overridden with
  `--ui`/`--no-ui`, so it stays cooperative.
- A separate rejection column. The count can be derived from rows already stored.
- Keeping `orch job pr` with validation. Nothing in the skill used it.

A human close-out (`resume --to completed`, recorded `acceptedByHuman: true`) is unchanged and
stays distinguishable from automatic completion.
