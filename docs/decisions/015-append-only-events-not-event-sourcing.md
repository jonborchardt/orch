# 15. Append-only events, not event sourcing

The `events` table is an audit log (`job.created`, `stage.started`, ...) written in the same
transaction as the state change. Current state lives in `jobs`; nothing is reconstructed from
events. A cascade delete is declared but no command deletes jobs.
