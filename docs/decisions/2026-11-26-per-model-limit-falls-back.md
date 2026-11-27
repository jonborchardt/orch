# A per-model limit falls back to another pool model; the draw is kept

**Decision.** A limit on a model with an allowance of its own does not end the run while every
affected role has another model in its pool.

- **Own allowance.** `OWN_ALLOWANCE_MODELS` in `src/core/roles.ts` lists the models whose
  allowance is separate from the account's; today only `fable`. `claudeLimit` reports
  `model: 'fable'` when the message names it ("Fable limit reached", "You've hit your fable
  limit"). A limit naming any other model (opus), or none (the main allowance), is account-wide
  and ends the run as before (decision
  [2026-11-24-usage-limit-ends-run-resumably](2026-11-24-usage-limit-ends-run-resumably.md)).
- **Detection.** The controller reads the child's stderr and error result, as before. A limit
  inside a subagent never reaches them, so the `/factory` session reports it with
  `orch job limit <id> --model <m> --text "<message>"`, which records a `models.limit` event
  `{ model, text, until }` on the job, and ends its turn. The controller reads the events recorded
  while its child ran; it parses no transcript. A limit it reads from stderr it records itself.
- **Fallback.** `fallbackModel` is pure: the next model after the role's current one in its
  configured pool, wrapping, skipping exhausted ones. The controller records one
  `models.fallback { role, from, to, text, until }` event per affected role and launches again;
  `resolveRoles` applies the events after the draw, the latest per role winning, so the plan
  names the new model for the rest of the job.
- **All or nothing.** If any role of the job whose model is exhausted has no other model in its
  pool, nothing is recorded and the job takes the account-wide path (`usage-limit`, resumable). A
  job half on a model that cannot run would stop a few stages later anyway.
- **Exhausted set.** A `models.limit` event whose text carried an epoch (`limit reached|<epoch>`)
  has an `until` time; while it is ahead, any controller process reads the event and records
  fallbacks for a job before each launch, new jobs included. A limit with no known reset is held
  in the controller's memory until that process exits; the next process pays one failed launch
  and falls back again. No table, no runner-state field, and no parsing of "3pm".

**Why the draw is kept.** `models.drawn` is the record of the model experiment (decision
[2026-11-25-model-pools-per-job-draw](2026-11-25-model-pools-per-job-draw.md)): it says what the uniform
draw assigned, and rewriting it would make a fell-back job look like an opus draw and skew the
comparison. So the draw is never touched and the fallback is a second fact beside it. Work is
credited to the model the role had when the work was recorded (`modelAt`): a review row stores
the fallback model, a spec challenge counts under the challenger's model when its review was
registered, a spec writer under its model when `spec.md` was registered, a builder under its
model at the job's end. Every `/api/agents` row from a job with a `models.fallback` event carries
`fellBack: true` (the Agents tab says "fell back"), and `orch job usage` lists the fallbacks, so
an analysis can leave those jobs out or count them apart. They are flagged, never relabelled.

**Limits.** No real `fable` exhaustion message could be collected when this was built; the forms
are the best-known ones, and a form the detector misses ends the run as before or counts as an
idle exit. Waiting for a reset is not part of this.
