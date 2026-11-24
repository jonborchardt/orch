# Manual and autonomous ticket runs; the dotodo skill is removed

**Decision.** `orch do <ticket>` (with `orch start` and `orch resume`) is the canonical entry
point for running a ticket autonomously. The controller creates or continues the ticket's job,
runs the headless `/factory <job>` child, reads CI, and merges through `mergeJob`. The
repository-local `dotodo` skill, which described the same sequence in prose, is removed (ticket
0100).

The manual path stays and is assembled only from existing commands: a person runs
`/factory <job>` in an interactive Claude session and can talk to that session while the job
runs. The job is one `orch do` created or stopped, or one started with
`orch factory start ... --ticket <id>`. Once it is `completed`, the person merges with
`orch do <ticket>` (`runTicket` merges a completed job) or `orch job merge <job>`.

What only dotodo did:

- **Ticking the delivered checklist boxes before the merge** is covered by the approval gate:
  `ops/gates.ts` refuses to complete approval while an unchecked box is neither ticked nor recorded
  in `decision.md`. Dotodo's fallback for jobs approved before that rule is dropped; a person ticks
  such a box with `orch ticket edit`.
- **Closing a ticket whose work is already on `main`** stays a human action, not automation: the
  person runs `orch factory cancel` on the job, then `orch ticket done <id> --note ...`. `orch do`
  reports a cancelled job as blocked and never replaces it.
- **Pre-flight checks and the table of merge outcomes** are already enforced by `listTickets`,
  `dispatchJob`, `runTicket`, and `mergeJob`, so they go with the prose.

**Why.** One sequence described twice drifts; the code is the version the gates enforce. A slim
`/dotodo` that only called `orch do` would rename a command, not add anything.

**Supersedes** `2026-11-18-dotodo-merges-outside-the-factory.md` as far as the skill is concerned.
`orch install` does not prune removed sources, so an earlier install's `~/.claude/skills/dotodo`
copy must be deleted by hand.
