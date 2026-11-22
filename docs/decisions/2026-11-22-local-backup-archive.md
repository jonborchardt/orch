# Backups are one validated tar.gz; restore installs only into an empty data directory

**Decision.** `orch backup create <file>` writes one gzip-compressed ustar archive: `manifest.json`
(format `orch-backup`, version 1), a SQLite snapshot as `orch.sqlite`, and every regular file under
`jobs/<id>/artifacts/` and `tickets/<id>/assets/`, at their data-directory paths. The snapshot is
`VACUUM INTO` on a separate raw connection (`src/storage/backup.ts`); the live database file is never
copied. The tar reader and writer are a few lines in `src/core/tar.ts` and the rules (allow-list,
manifest, hash checks, schema check) are pure in `src/core/backup.ts`. `orch backup restore` never
overwrites: it refuses a destination with a database, `jobs/` or `tickets/` content, or a live
controller, recovery worker, or verify holder, stages and validates inside the destination,
migrates through `openStore`, moves the directories, and installs the database last with a hard
link, which fails if a file appeared meanwhile. Neither command goes through `withStore`.

**Why.** Node has `zlib` but no tar, and the project adds no dependencies; a ustar subset of
regular files is small and readable by any `tar`. `VACUUM INTO` is one read transaction, so in WAL
mode writers continue and committed WAL content is included; `node:sqlite`'s `backup()` restarts on
every source change and could starve under a busy controller. Registered artifacts are ordinary
files that `artifact add --replace` rewrites, so no lock is taken: the backup compares each file
with the row in its own snapshot and retakes the snapshot a bounded number of times, which keeps
the controller and job flow untouched. A restore that could overwrite would be the one command able
to destroy every job record at once, so it has no `--force`; replacing data means moving the old
directory aside first.

**Left out.** Streaming (archives are built in memory), encryption, incremental backups,
scheduling, a dashboard route, and user configuration (`<config>/factory.json`), which the request
did not list.
