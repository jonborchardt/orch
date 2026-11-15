# 22. GitHub through `gh`, with a shim for tests

No GitHub SDK: `gh` is already authenticated on the developer's machine and covers issues, PR
listing, draft creation, and `statusCheckRollup`. `src/integrations/github.ts` invokes it with
argument arrays and parses `--json`. `ORCH_GH_SHIM=<file>` swaps the executable for
`node <file> <args>` so tests run a stateful fake and never touch the network. `orch` never merges,
force-pushes, or marks ready: approval permits a draft PR, humans do the rest.
