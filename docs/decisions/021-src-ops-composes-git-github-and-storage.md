# 21. `src/ops/` composes Git, GitHub, and storage

Worktree creation and PR delivery are sequences: check ownership, act on Git or GitHub, record the
result. They do not belong in `src/cli/` (no business logic), `src/core/` (no I/O), or
`src/storage/` (no Git). `src/ops/` holds them; it is the only layer that imports from both
`src/git`/`src/integrations` and `src/storage`. `authorize()` in `storage/jobs.ts` performs the
ownership and revision check without a write so the Git action can run first.
