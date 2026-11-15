# 18. Artifact structure rules and markers are code (Phase 3A)

`src/core/artifact-rules.ts` maps each workflow artifact path to required headings and, for
reviews, consolidations, and decisions, a single marker line (`VERDICT: PASS|CHANGES`,
`BLOCKING: <n>`, `DECISION: APPROVE|ESCALATE`). Registration parses the marker into
`artifacts.marker`, and the pure `transition` reads it: `approve` completes only on `APPROVE`, and
`review record --verdict` must agree with the file. Skill prose can ask a reviewer for a verdict,
but only the CLI decides whether a stage is done. Other files in the artifact directory (evidence,
screenshots' notes) are unconstrained so reviewers can attach what they like.
