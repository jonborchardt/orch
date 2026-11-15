# Archive is a column on finished jobs

**Context.** The board lists every job ever run, so finished jobs crowd out the live ones. A human
wants to hide old runs and still be able to find them.

**Decision.**

- Archive state is a nullable `jobs.archivedAt` timestamp, set and cleared by the dashboard's
  `archive` / `unarchive` actions through `setArchived` in `src/storage/jobs.ts` (owner-checked,
  one transaction, events `job.archived` / `job.unarchived`). State goes in a column and history in
  events, the same split as supersession (`supersededBy`).
- Only terminal jobs (`TERMINAL_STATUSES`: completed, cancelled) can be archived. A live, blocked,
  interrupted, or failed job can never be hidden, so nothing that needs a human disappears.
- Archiving changes no workflow field and deletes nothing. It is a short `dashboard` lease episode
  like every other dashboard action, so a live lease is respected unless the human forces it.
- Hiding is the client's job: `/api/jobs` returns every row with `archivedAt`; the board's Show
  filter leaves archived rows out of every view except `archived`.

**Rejected.**

- Browser-local hiding (localStorage): needs no schema, but differs per browser and is lost with
  the profile.
- Archive by age, bulk "archive all finished", or automatic archiving: can be added later on the
  same column if hand archiving proves too slow.
- A CLI command: the request was for the dashboard; `orch job list` is unchanged.
