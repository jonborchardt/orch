# 44. Cleanup pass: what was consolidated and what was deliberately left (Phase 5C)

Consolidated: all error classes (including `UsageError`) live in `core/errors.ts`, so the
dashboard maps them to HTTP statuses with `instanceof`; `MergeConflictError` carries the
conflicting files instead of callers parsing a message; `runTool` is `spawnCommand` with the
result reduced to stdout; CLI option parsing (`cli/args.ts`) replaced four copies of `--revision`
handling; `mutateReturning` replaced six definite-assignment assertions; the board reads reviews
and artifacts for all jobs in two queries; `inspectWorktree` derives `changedFiles` from the
name-status diff instead of a second `git diff`; push and PR creation inspect the worktree once.
A reordering of `factory.json` commands now counts as a policy change everywhere (it already
changed the fingerprint, so a run could be refused without the plan saying why).

Left alone on purpose: the seven reviewer agent files repeat the same rules block. Claude Code
loads one agent file per subagent with no include mechanism, so sharing the text would need a
generated artifact; the duplication is the cost of self-contained agents and a contract test keeps
the files consistent with `core/roles.ts`. `web/src/Actions.tsx` keeps its own stage list and
live-lease check because the client may import only types from `src/`.
