# 9. SQLite via built-in `node:sqlite` (resolves the Phase 1 deferral)

`node:sqlite` (`DatabaseSync`) is synchronous, needs no native build, and imports without an
experimental warning on Node 24. Synchronous access matches the CLI's one-shot model, and
`BEGIN IMMEDIATE` transactions plus a 5 s `busy_timeout` serialize concurrent CLI processes on
SQLite's write lock. WAL mode lets readers (`job list`, `job show`, a future dashboard) run while a
writer holds the lock. `better-sqlite3` (native build) and `sql.js` (no multi-process safety) were
rejected. All access sits behind `src/storage/`.
