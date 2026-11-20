# The artifact route serves recorded logs by their recorded path

**Decision.** `GET /api/jobs/<id>/artifacts/<path>` serves, besides that job's registered
artifacts, the verification and CI logs orch itself recorded for that job: a check's `outputPath`
of one of the job's verification runs, or a `failures[].log` of one of its `ci.observed` events.
The requested path must equal the recorded value exactly and match the shape orch writes
(`verification/<run>/<check>.log` or `ci/<sha7>/<name>.log`, no `.` or `..` segment); payload
values that are not strings or not log-shaped are ignored. Logs are not registered as artifacts.
Before reading, the file's real path must lie inside the real path of the job's artifact
directory, so a junction or symlink cannot lead out; that, a missing file, or a read error is a 422.
A path segment containing `\`, `:` or NUL is a 400. Logs are sent as `text/plain; charset=utf-8`
with `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. There is no new route.

**Why.** The detail view showed log paths as plain text, which a reader could not open. Registering
logs would turn every verification run and CI observation into artifact rows that gates, counts,
and the Artifacts tab would then have to tell apart from deliverables; the runs and events already
record the paths, so the route checks against those records instead. The allow-list is exact so
the route never becomes a general file server, and the shape check means a poisoned
`ci.observed` payload cannot name an arbitrary file.

**Exposure.** Logs may contain secrets that a check or a CI job printed. They are served only on
`127.0.0.1`, behind the same `Host`, `Sec-Fetch-Site` and job-id guards as the artifacts already
served. That stops other websites (DNS rebinding, cross-site requests) and other machines, but not
another local user or process that can reach loopback, which can already read the files on disk.
`text/plain` plus `nosniff` are required because logs carry attacker-influenced CI output: a
browser must never render or sniff it as HTML or script.

**Limits.** A check id with characters outside `[A-Za-z0-9._-]` produces a log the shape check
refuses; it is shown as text. Every `ci.observed` event of the job is consulted (no cap), and only
the newest observation's failures are displayed. Commit links (`links.repo`) exist only for
`github.com` identities, and only for commits known to be on the remote; GitHub Enterprise and
other hosts get PR links (from the recorded PR URL) but no commit links.
