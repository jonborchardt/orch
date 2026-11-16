# orch marks a passing PR ready; humans still merge

Supersedes the "marks ready" part of decision 22 (`022-github-through-gh-with-a-shim-for-tests.md`).
The rest of 22 stands: GitHub through `gh`, the test shim, never merge, never force-push.

**Decision.** When `orch gh ci` completes a job on passing required checks for the current PR
head, and the PR is an open draft, it runs `gh pr ready <url>` through `markPrReady` in
`src/integrations/github.ts`. The outcome is one owner-checked write (`recordPrReady` in
`src/storage/jobs.ts`): event `pr.ready` `{ head, ok, error }`, and `prState: ready` on success.
The `orch gh ci` result carries `ready: marked | already | failed` and `readyError`.

- Order: strictly after `completeCi` commits. A failed or interrupted ready never undoes or skips
  the verdict; the job stays `completed` / `passing` and the PR stays draft.
- No retry and no retry command. A failure is reported (event, CLI output, the factory's done
  message) and a human runs `gh pr ready`.
- Only this path. `accept-delivery` / `resume --to completed` (a human close-out without a
  passing verdict), `pr create`, and `pr status` never mark ready. The skill still never runs
  `gh pr ready` or `gh pr merge`; `tests/audit.test.ts` allows `'pr', 'ready'` in exactly one
  source file.

**Why.** A passing verdict for the exact head is the evidence a human used to wait for before
clicking "Ready for review"; requiring the click added a step without adding a check. Merging is
the human decision, and it stays one.
