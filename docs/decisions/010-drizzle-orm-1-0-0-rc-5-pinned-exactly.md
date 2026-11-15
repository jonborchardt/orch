# 10. Drizzle ORM 1.0.0-rc.5 pinned exactly

Drizzle's `node:sqlite` driver (`drizzle-orm/node-sqlite`) only exists in the 1.0 line; the latest
stable `0.45.x` does not ship it. The rc is pinned exactly (`drizzle-orm` runtime,
`drizzle-kit` dev) rather than ranged, so upgrades are deliberate. The schema is TypeScript
(`src/storage/schema.ts`); `drizzle-kit generate` produces versioned SQL under `drizzle/` that is
committed and shipped; `migrate()` applies pending migrations when the CLI opens the database.
`drizzle-kit push` is never used against the runtime database. Records use Drizzle's inferred
types; nothing outside `src/storage/` imports the driver.
