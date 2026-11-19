# orch verify reuses a still-valid run

**Decision.** `verifyJob` in `src/ops/verify.ts`, after the same `authorize()` and clean-worktree
refusal as before, asks `verificationStatus` whether the job's latest run is still valid for the
current HEAD, tree, and effective policy (`runInvalidReason` in `src/core/verification.ts`). If it
is, it returns that run with `reused: true` and records nothing, without taking the verify lock.
Otherwise it starts a new run exactly as before. There is no flag to force or skip a run, and no
gate changed: every gate still recomputes validity itself.

**Why.** The gates already accepted the build's run after a simplify that committed nothing, but
`orch verify` always started a fresh 10-18 minute suite. Reuse removes that run without weakening
what a run proves.

**Docs-only base integrations still rerun.** "Non-code" cannot be defined safely here:
`npm run check` runs `format:check` over Markdown, and the skill-contract and install tests read
`skills/` and `agents/` Markdown. Accepting a run for a different tree would also undo the rule
that evidence is pinned to the exact tree. A repository-declared ignore list in `factory.json`
would be a policy change needing human acceptance and a change to `runInvalidReason`; it is left
for later. The `pr` stage already skips verify when the base did not advance.

**Limits.** A flaky pass is reused until HEAD moves, the same trust the gates already place in it.
Environment drift (a new Node, a changed tool on PATH) is not part of the tree or the policy
fingerprint, so a reused run does not reflect it.
