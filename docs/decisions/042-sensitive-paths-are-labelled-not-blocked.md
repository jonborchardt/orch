# 42. Sensitive paths are labelled, not blocked

`core/sensitive.ts` classifies the diff (tests, test config, CI, dependencies, policy), scans the
diff of changed test files for skip/only/commented-out markers and removed definitions, and diffs
the policy. The output is a report in the plan; the only hard rules are that `consolidated.md` and
`pr.md` must name each sensitive path under a `Sensitive changes` heading, and that an
unauthorized policy change blocks approval and delivery. A generalized policy language was
rejected: a reviewer reading the diff is the control, the CLI just makes sure the diff is on the
table.
