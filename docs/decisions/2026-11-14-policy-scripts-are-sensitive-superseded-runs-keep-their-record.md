# Files a policy command runs are sensitive; a superseded verification run keeps its record

**Observed (hardening investigation, `3653bcf`).** The base-branch policy fixes which commands run,
not what they execute. A job rewrote `check.js` (the policy runs `node check.js`) to print `OK`,
and its product change that the real check would have rejected passed `orch verify`. Nothing
labelled the edit, because `check.js` is neither a test nor a config file.

A second problem showed up separately. In Claude Code 2.1.323 a command that outlasts the Bash
tool's limit keeps running in the background, so a second `orch verify` can start while the first
is alive. `startRun` marks the first run `interrupted`, but the first process's late `recordCheck`
and `finishRun` updated rows by id and rewrote that record (to `passed` or `failed`). That was
never evidence, because validity reads the newest run, but it was a false audit trail.

**Decision.**

- **Policy scripts are sensitive.** `policyScriptPaths` (`core/sensitive.ts`, pure) resolves every
  command word and argument of the effective policy against the command's `cwd`, using the value
  after `=` for `--flag=value`. A changed path that matches is labelled `policy` ("a file the
  verification policy's commands run directly"). The existing rule then applies: the consolidated
  review and the PR body must name it, and reviewers read its diff. Nothing is blocked, because
  editing a verification script is often legitimate.
- **Only a run that is still `running` accepts check results or a terminal status.** Anything else
  is refused with "superseded", and the late process's log file stays on disk.
- **The skill and the builder are told** to wait for a backgrounded `orch verify`, never to start
  a second one, and never to treat an unfinished run as a pass.

**Rejected.**

- Blocking or hashing verification scripts.
- Following indirect execution (a script that calls another file). That is the reviewers' to
  judge.
- A lock row or a heartbeat for verification. `startRun` already resolves a stale run.
- A daemon or a detached verifier.
