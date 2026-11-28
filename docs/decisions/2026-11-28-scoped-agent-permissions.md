# Agent permissions are added in the user's config, scoped by identity; a gap caps the grade at B

Ticket 0200. A factory session's `claude -p` arguments are derived by one pure function,
`runnerArgsFor` in `src/core/roles.ts`: the base (`runnerClaudeArgs`, else the defaults), then
`extraAllowedTools`, then `repoAllowedTools[<identity>]`, merged into the base's `--allowedTools`
group with duplicates dropped. All three keys live only in the user's `<config>/factory.json`.

Permissions are never read from a repository, including its `factory.json`: a repository a job
works on would otherwise grant its own agents what they may run. Scoping is by the repository
identity `mergeRepos` already uses, so the user states once, in one file, what each repository's
agents may do. `runnerClaudeArgs` replaces only the default list; additions still apply on top,
because an override that silently disabled a repository's scoped rule would reintroduce the stall
the rule was added to prevent. A rule may not start with `-`, so it can never become a flag.

`orch init --check` compares the trusted policy's executables with the effective allow-list. An
executable no rule covers caps the readiness grade at B and adds one advice line with the exact
setting that closes it. It is a cap, not a fifth fact, so every place keeps printing `(n/4)`. The
grade stays advice (decision 2026-11-25-readiness-grade-is-advice): no exit code, gate, or merge
reads it. The coverage rule reads rule text (`Bash`, `Bash(*)`, `Bash(<exe> *)`,
`Bash(<exe>:*)`, or a permission bypass); an override spelled another way may show a false gap,
whose advice still names a setting that closes it.
