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
  `/factory dispatch`'s parallel session launch is retired
  ([2026-11-25-retire-dispatch-launch](2026-11-25-retire-dispatch-launch.md)).
- **Live steering**: `orch` never messages a running session.
- **Cloud or daemon**: nothing runs after the command exits, nothing is hosted.
- **Team sync**: the queue is one person's, local and single-user.
- **More LLM-judged reviewers**: another opinion is not evidence; prove it in code instead.
- **Gate-skipping flags**: no option bypasses a gate, for speed or otherwise.

**Why.** Per [landscape.md](../landscape.md), other tools are already stronger at breadth (more
agents, hosts, or people), so a feature that adds breadth without proof competes where `orch` is
weak, and one that weakens a gate gives up the position itself.
