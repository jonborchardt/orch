# 26. `orch factory next` is the skill's oracle (Phase 3B)

The coordinating Claude session never reasons about workflow state. `src/ops/factory.ts` turns the
job row, its artifacts (re-verified against disk), its worktree, and the role configuration into a
plan: the step, the agents with models and target artifacts, and the literal `orch` commands to run.
The skill prose is therefore short and the behaviour is testable without a model. Every plan command
carries `--token <token>` because shells spawned by Claude Code do not keep environment variables.
