# The readiness grade is advice, never a gate

Ticket 0157. `orch init --check` reports a grade, A to D, from four facts orch can read: the
trusted policy has a required check that runs tests, and GitHub requires status checks on the base
branch, requires it up to date (or runs a merge queue), and protects it. `orch factory config
merge` and the dashboard's Merge dialog (fetched only when it opens, from
`GET /api/jobs/:id/readiness`) show the same grade beside the merge opt-in.

The grade changes no exit code, status, transition, or merge decision. `mergeDecision`,
`mergeJob`, the gates, and the runner never read it. A weak grade is a reason for the human to
tighten the repository before enabling unattended merges, not a rule orch enforces: the facts come
from a heuristic (the test-command match) and from GitHub endpoints that may need admin rights, so
they can be wrong or unknown. A missing answer is unknown and never counts as met.

GitHub is asked only when origin is `github.com/<owner>/<name>`; any `gh` failure, including no
`gh` at all, leaves its facts unknown. `orch factory dispatch` and `orch doctor` keep the
grade-free `checkReadiness`, so starting a job never calls GitHub for advice.
