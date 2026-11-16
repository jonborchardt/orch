# Finishing a job releases it

**Context.** A completed or cancelled job kept its finishing session's owner, token, and lease for
up to 30 minutes, so archiving it from the dashboard right after delivery needed a forced
takeover, and the board showed a live owner on a job nobody was working.

**Decision.**

- `mutate` in `src/storage/jobs.ts` clears `ownerSession`, `ownerToken`, and `leaseExpiresAt` in
  the same write as any decision that moves a job to a terminal status (complete, cancel, a human's
  accepted delivery). Authorization is checked before, and the write's events keep the finishing
  session as actor.
- The one exception is `orch gh ci` completing a job whose PR is a draft: it passes `holdLease` so
  the `pr.ready` write that follows (decision `2026-11-15-orch-marks-a-passing-pr-ready.md`) is still
  owner-checked; `recordPrReady` then releases the job.
- Any later write to a finished job (archive, supersede, recording PR state) claims it first, as the
  dashboard already does.

**Rejected.** Releasing in each caller after the transition: not atomic, and every new terminal path
would have to remember it. Recording `pr.ready` before completion: a failed or interrupted ready
could then precede the verdict, which the ready decision rules out.
