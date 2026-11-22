# 22. GitHub through `gh`, with a shim for tests

Superseded in part: the "never merges or marks ready" clause by
`2026-11-15-humans-merge-from-the-dashboard.md`, `2026-11-15-orch-marks-a-passing-pr-ready.md`,
and `2026-11-20-orch-job-merge.md`.

No GitHub SDK: `gh` is already authenticated on the developer's machine and covers issues, PR
listing, draft creation, and `statusCheckRollup`. `src/integrations/github.ts` invokes it with
argument arrays and parses `--json`. `ORCH_GH_SHIM=<file>` swaps the executable for
`node <file> <args>` so tests run a stateful fake and never touch the network. `orch` never merges,
force-pushes, or marks ready: approval permits a draft PR, humans do the rest.
