# Attributed findings and per-model notes, parsed from artifacts and never acted on

Ticket 0169. Every `[BLOCKING]` line of `round-N/consolidated.md` ends with
`(reviewers: <names>)`, and the next `build.md` answers each finding `N.k` as `fixed` or
`declined — <reason>`. `ops/gates.ts` enforces both at registration only: a consolidation without
tags registered earlier stays legacy, is "not attributed", and needs no answers. The Agents tab
turns the rows and artifacts into per-model metrics and fixed-rule notes.

Why tags and answers in Markdown: the coordinator and builder already write these files, so the
attribution costs one line per finding and no schema. The gate makes the format evidence, not a
habit. The one piece that would otherwise be lost is build.md's answers, because build.md is
replaced every round: its registration event keeps the checked answers (`payload.answers`), and
the read model takes the latest answer per id.

Why these outcomes: fixed, declined, overruled (declined, then an APPROVE), vanished (the job
finished unanswered), and open (excluded). A fixed finding is a real catch only when the raising
reviewer passes the next round; with no next-round verdict it is unresolved and counts as
neither catch nor false alarm. Vanished counts as a false alarm because the ticket says so, though
a missing answer is weak evidence; excluding open and unresolved findings limits the damage.

Why escapes look like this: orch records no Git revert, so a revert is seen only through a ticket
whose title says "revert" and that names the job or its PR. A CI repair counts against the
reviewers who passed the last review round finished before it.

Why whole-job tokens: a `token_usage` row holds a session's hourly totals with no agent column, so
tokens are attributed to the building role's drawn model per job. A token note compares jobs
grouped by the builder's model, not the builder's own spend. Per-review tokens need ticket 0083.

Why fixed rules and no automatic pruning: a note is computed (minimum sample 20, a two-proportion
z-test at |z| >= 1.96, a confidence label from the smaller sample) so it can be checked. It advises
the person who edits the pools; nothing in orch edits `factory.json` or a pool.
