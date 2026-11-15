# 27. Roles and models are data

`src/core/roles.ts` is the single table of role → agent → default model → applicability, mirrored
by the agents' frontmatter (a test keeps them in sync). `<config>/factory.json` overrides models,
the UI detection patterns, and the default round limit per machine. UI reviewers are added when the
job's changed files match the patterns; `--ui`/`--no-ui` overrides. Nothing else in the code names
a model.
