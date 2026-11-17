# A job requires a description

**Decision.** `createJob` in `src/storage/jobs.ts` refuses a description that is missing or blank
after `trim()` with a `UsageError` (exit 2), before the insert, the `job.created` event, and the
artifact directory, so nothing is created. Title-only creation is removed from `orch job create`,
`orch factory start`, and `orch factory dispatch`. With `--issue` and no `--description`, `start`
and `dispatch` fetch the issue (also when `--title` is given) and use its URL and body; an explicit
blank `--description` still wins and is refused. `orch job create` never calls `gh`, so it always
needs `--description`. A valid description is stored as given, untrimmed.

**Why.** A job without its request cannot be specified; such jobs were dispatched, found empty by
the child session, and cancelled. One guard at the shared creation boundary covers every entry
point without duplicating the rule in each CLI handler.

**Limits.** The column stays nullable, so older rows without a description remain readable. A
description that was truncated but still has text passes. `--title X --issue N` now calls
`gh issue view`, so a `gh` failure there fails creation.
