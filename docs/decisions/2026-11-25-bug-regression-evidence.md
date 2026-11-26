# A bug fix is verified only with a test that fails on the base and passes at HEAD

Tickets 0156 and 0162. A bug ticket's job could pass every gate with a fix and no test that would
have caught the bug, so nothing stopped the same bug coming back.

- **Opt-in policy.** The gate exists only where the repository's effective policy sets
  `verification.regression` (a command, args, cwd, timeout; no shell). A repository without it,
  and every non-bug job, verifies as before.
- **orch picks the tests.** The files the job added or modified since the merge base that
  `src/core/sensitive.ts` labels `tests` (renames do not count). No agent names them, so an agent
  cannot point the gate at a test that proves nothing.
- **Red in the job's worktree.** After the policy passes, under the verify lock, orch reverts every
  non-test change to the merge base (restoring modified and deleted files, removing added ones),
  runs the tests (they must fail), restores HEAD, and runs them again (they must pass). The tests
  run at their HEAD version against the base code, in the same worktree and dependencies as the
  policy run; the worktree must be clean at the same HEAD afterwards.
- **Exempt.** A job whose every changed path is `*.md` records `exempt` and passes: there is no
  code to test.
- **Ceiling: any non-zero exit at the base is red.** A test that cannot even import code the base
  lacks counts as red. Telling "failed an assertion" from "failed to load" would need a
  per-runner parser; reviewers see the red log.
- **The gate.** `verificationStatus` in `src/ops/verify.ts` is valid for a bug job only with a
  `passed` or `exempt` record for HEAD, tree, merge base, and policy fingerprint; the ticket type
  is read when the gate runs. Every gate already asks `verificationStatus`, so none is edited on
  its own, and `orch verify` reports a refused run as `failed` so a builder never cites a run the
  gates reject.
- **No waiver flag.** A flag would be one more way past a gate for an agent under pressure. A bug
  that truly cannot have a test is a human's call: reclassify the ticket
  (`orch ticket edit <key> --type chore`), which lifts the gate at once and is recorded in the
  ticket's history. Agents never reclassify; a job that cannot add the test escalates through
  `needs-human`. A code check that refuses reclassification while a job holds the ticket is later
  hardening.
