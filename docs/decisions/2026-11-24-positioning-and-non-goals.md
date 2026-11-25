# Positioning: autonomy with code-enforced assurance, and what orch will not do

**Decision.** `orch` is autonomy with code-enforced assurance: it drains a ticket backlog to merged
without supervision, and every step that decides whether work is right is enforced in TypeScript
(stage gates, evidence `orch` executed and pinned to a commit, an exact-head merge), not delegated
to branch protection, human review, or an agent's word. Tagline: "Unattended, not unchecked."

A new feature fits if it does at least one of these, with no daemon, server, or team:

1. **Proves more**: more of what a merge rests on is executed or checked by code.
2. **Interrupts less**: the human is needed for fewer decisions, or for the same ones less often.
3. **Shows the receipt**: the evidence behind a step or a merge is easier to see.
4. **Lowers intake friction**: getting work into the queue, or a repository onboarded, is easier.

Non-goals, which a ticket or reviewer can cite to decline a feature:

- **Parallel throughput**: one ticket at a time keeps evidence pinned to one head.
- **Live steering**: `orch` never messages a running session.
- **Cloud or daemon**: nothing runs after the command exits, nothing is hosted.
- **Team sync**: the queue is one person's, local and single-user.
- **More LLM-judged reviewers**: another opinion is not evidence; prove it in code instead.
- **Gate-skipping flags**: no option bypasses a gate, for speed or otherwise.

**Why.** The 2026-11-24 study of about 45 tools ([landscape.md](../landscape.md)) found that other
tools get autonomy by handing assurance to branch protection and human review; `orch`'s place is
the combination of the two. A feature that adds breadth (more agents, more hosts, a team) without
adding proof competes where others are already stronger, and one that weakens a gate gives up the
position itself. Writing the test down lets a ticket or a review settle "does this fit" by citing
it.
