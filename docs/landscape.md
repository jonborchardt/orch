# Landscape: where `orch` sits among AI coding tools

A positioning study on 2026-11-24 looked at about 45 tools that write, run, review, or merge code
with AI agents. This page keeps its result at category level. The deep, source-read comparisons
stay in [overview.md](overview.md): [Compared with Beads](overview.md#compared-with-beads) and
[Compared with agent-orchestrator and Gas Town](overview.md#compared-with-agent-orchestrator-and-gas-town).
The README has the short version of the table below.

## How to read the claims

Every row and claim carries a date and a basis:

- **demonstrated**: read in source or docs, with the reading dated and pinned. Here that means
  `overview.md`'s readings of 2026-11-20 (AO at commit `7919c96`, Gas Town at `94cc822`) or this
  repository itself.
- **claimed**: a vendor's description or the study's summary, not verified here. A claimed row
  describes a typical tool in the category; any one product may differ.

Tools in every category change quickly; check a claim before relying on it.

## By category

The columns are the four axes the README uses: who decides the steps, who runs the checks, what
stops a wrong merge, and what runs unattended.

| category                   | who decides the steps                                       | who runs the checks                                        | what stops a wrong merge                                                                  | what runs unattended                                                  | basis                    |
| -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| Cloud agents               | the agent, from a task prompt                               | the agent in its sandbox, then the repository's CI         | branch protection and human review of the PR                                              | one task, up to a PR                                                  | claimed, 2026-11-24      |
| Claude Code's own features | the agent and the person in the session                     | the agent, when told to                                    | human review                                                                              | a session, a headless run, or subagents, as far as one prompt goes    | claimed, 2026-11-24      |
| Worktree GUIs              | the person, choosing what each session does                 | the agents, or the person                                  | human review                                                                              | several sessions side by side, each watched by the person             | claimed, 2026-11-24      |
| Spec frameworks            | a written procedure the agent follows                       | the agent                                                  | human review                                                                              | the steps of one feature, as long as the agent keeps to the procedure | claimed, 2026-11-24      |
| Open-source agents         | the agent                                                   | the agent, or CI                                           | branch protection and human review                                                        | one task                                                              | claimed, 2026-11-24      |
| Tracker agents             | the agent, from an issue assigned to it                     | the repository's CI                                        | branch protection and human review                                                        | an issue to a PR                                                      | claimed, 2026-11-24      |
| Review bots                | not applicable: they comment on PRs others open             | an LLM reading the diff                                    | nothing by themselves; a person acts on their comments                                    | a review of every PR                                                  | claimed, 2026-11-24      |
| Merge queues               | not applicable: they order merges, they do not write code   | CI, on the merged result                                   | the queue tests the PR merged with what is ahead of it before landing                     | merging approved PRs                                                  | claimed, 2026-11-24      |
| Gas Town                   | agents, from written procedures                             | the merging agent, locally, which may merge past a failure | the merging agent's judgement; its strict Go merge engine is not on the running path      | a daemon and supervising agents that restart workers                  | demonstrated, 2026-11-20 |
| AO (agent-orchestrator)    | an orchestrating agent, from its prompt                     | GitHub, read fresh before a merge                          | a person asks for the merge; the head must match and checks pass                          | many sessions, kept alive by a daemon; nothing merges automatically   | demonstrated, 2026-11-20 |
| `orch`                     | code: `orch factory next` and TypeScript transitions, gates | `orch` itself, pinned to a commit, then GitHub's checks    | `mergeDecision`: exact-head merge, current base, verified evidence, opt-in per repository | a ticket backlog drained to merged, one ticket at a time              | demonstrated, 2026-11-25 |

The Gas Town and AO rows summarise the tables in
[overview.md](overview.md#compared-with-agent-orchestrator-and-gas-town). The `orch` row is this
repository: [workflow.md](workflow.md), `src/core/workflow.ts`, `src/ops/merge.ts`.

## The finding

Claimed, 2026-11-24, from the study's summary: other tools buy autonomy by delegating assurance to
branch protection and human review. Those that run far without a person (cloud and tracker agents,
Gas Town) leave the merge decision to a person or an agent's judgement; those that enforce a merge
rule (merge queues) do not write the code. `orch` is the only tool in the study that combines high
autonomy, draining a backlog to merged, with assurance enforced in code: stage gates, executed
evidence pinned to a commit, and an exact-head merge. In short: **Unattended, not unchecked.**

What that position does and does not cover is recorded in
[decisions/2026-11-24-positioning-and-non-goals.md](decisions/2026-11-24-positioning-and-non-goals.md).

## The merge-result gap

Demonstrated, 2026-11-24, from this repository: `mergeDecision` refuses a base that moved since
`ciHead` ([decisions/2026-11-24-merge-requires-current-base.md](decisions/2026-11-24-merge-requires-current-base.md)).
What remains open is the race between that compare and `gh pr merge`, and that nothing tests the
merged result the way a merge queue does.

## Name collisions

Claimed, 2026-11-24, from the study's summary: "agent-orchestrator" is also attributed to Composio's
AO (not verified to be the project `overview.md` reads), and "factory" is used by factory.com and
others.
