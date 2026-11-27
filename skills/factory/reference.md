# Factory reference: agent inputs and artifact templates

`orch` validates every artifact against `src/core/artifact-rules.ts`: required headings
(case-insensitive, any level) and, where shown, exactly one marker line. Copy the templates;
keep the markers as whole lines.

## Agent inputs per stage

Every prompt starts with the header block from SKILL.md. Add:

| Stage              | Agent                     | Extra inputs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`             | `factory-spec-writer`     | The request; issue body if any; "read CLAUDE.md / AGENTS.md / README in the worktree first". After a scope-gap rework (`plan.reason` says "Scope gap"): the path to `decision.md` and "revise spec.md to cover every requested case it names".                                                                                                                                                                                                                                                                                                 |
| `spec`             | `factory-spec-challenger` | The request; issue body if any; path to `spec.md`; for `spec-review-2.md` or `-3.md` the paths to the earlier ones; "read CLAUDE.md / AGENTS.md / README in the worktree first". For the writer's revision: the path to the latest `spec-review-N.md` and "answer its material findings, do not expand scope".                                                                                                                                                                                                                                 |
| `build`            | `factory-builder`         | Path to `spec.md`; round number; for rounds > 1 the path to `round-<N-1>/consolidated.md` and "address every blocking finding, do not expand scope"; validation commands. After a CI rework (`plan.reason` says "CI repair"): the failing check names and the saved log paths under `<artifactDir>/ci/<sha7>/`, and "fix the defect; never weaken checks, tests, CI workflows, or factory.json". After a scope-gap rework (`plan.reason` says "Scope gap"): the path to `decision.md` and "implement every in-scope item it names as missing". |
| `simplify`         | `factory-simplifier`      | Paths to `spec.md` and `build.md`, the base ref (`plan.worktree.baseRef`) for `git diff <baseRef>...HEAD`, round number, and the artifact path `round-N/simplify-review.md`; "read only, never edit the worktree".                                                                                                                                                                                                                                                                                                                             |
| `simplify`         | `factory-builder`         | Paths to `spec.md`, `build.md`, and `round-N/simplify-review.md`; "apply the findings that make sense, never widen scope, commit if anything changed, run orch verify (it returns the build's run when nothing changed), record each applied and declined finding with its reason"; the artifact path `round-N/simplify.md`.                                                                                                                                                                                                                   |
| `review`           | each `factory-reviewer-*` | Paths to `spec.md`, `build.md`, `round-N/simplify.md`, the evidence dir if one exists, `git diff <baseRef>...HEAD` hint, the base ref (`plan.worktree.baseRef`), round number, and the artifact path.                                                                                                                                                                                                                                                                                                                                          |
| `build` (fast job) | `factory-fast-builder`    | The ticket key (`orch ticket show <key> --json`), the token for `orch verify` and `orch ticket edit`, and the artifact path `build.md`; "implement the ticket and nothing more; escalate instead of widening scope". After a CI or base-integration rework: the reason and the saved log paths, and "replace build.md".                                                                                                                                                                                                                        |
| `approve`          | `factory-approver`        | Paths to `spec.md`, `build.md`, every `round-*/review-*.md` and `consolidated.md`, the base ref for the diff, and the round count.                                                                                                                                                                                                                                                                                                                                                                                                             |

Builder validation: `orch verify <id> --token <t>`, which runs the repository's `factory.json`
verification policy (see README, "Verification evidence"). The builder runs targeted tests while
iterating; the full suite runs through `orch verify`, and only `orch verify` produces evidence.
Give the builder and every reviewer the latest run id and `plan.sensitive` (paths, disabled tests, policy drift).

## spec.md

```markdown
# <Title>

## Goal

One paragraph: what changes for the user and why.

## Scope

In scope:

- ...

Out of scope:

- ...

## Acceptance criteria

- [ ] AC1: <observable, testable statement>
- [ ] AC2: ...

## Affected surfaces

<CLI / API / UI / data / docs>

## Expected files or modules

- `path/to/file` — <change>

## Risks

- ...

## Verification

Locally verifiable: AC1, AC2 (<how: command or test name>)
Needs human or deployment: <list, or "none">
```

## build.md

```markdown
# Build: <Title> (round <N>)

## Summary

What was implemented and how; commits on the branch (`git log <baseRef>..HEAD --oneline`).

## Changes

- `path` — <what>

## Validation

Verification run: `orch verify` run <id> at <HEAD sha>, status passed; checks: <id: passed, ...>.
Logs: `<artifactDir>/verification/<run>/<check>.log`. Targeted checks, each as run with its
result or as not run with why (never a check you did not run written as passed):

- `<targeted test command>` → pass (N tests)
- `<other check>` → not run: <why>
- ...

## Acceptance criteria

- AC1: met — <evidence: test name, screenshot path, command output>
- AC2: ...

## Findings addressed (rounds > 1 only)

- 1.1: fixed
- 1.2: declined — <reason>

## Known gaps

<anything not done, or "none">
```

## spec-review-N.md

```markdown
# Spec challenge

## Findings

1. <spec section> — <material problem: missing behaviour or AC, ambiguity, unneeded scope,
   convention conflict, unverifiable AC, unjustified assumption> → <correction>
   (or "None material.")

VERDICT: PASS
```

`VERDICT: CHANGES` when any finding is material. Only `spec-review-1.md` and, each after a
revision of `spec.md` answering a CHANGES, `spec-review-2.md` and `spec-review-3.md` exist; `orch` binds each to the `spec.md` registered at the time,
and the spec stage completes only on a PASS for the current `spec.md`.

## round-N/simplify-review.md

```markdown
# Simplify review (round <N>)

## Findings

1. <file:lines> — <what does not need to exist, re-implements an existing helper, or is bigger
   than the problem> → <delete it, or replace it with: existing helper path / stdlib call>
   (or "None.")
```

## round-N/simplify.md

```markdown
# Simplify (round <N>)

## Applied

- <finding number> → <what changed, commit sha> (or "none")

## Declined

- <finding number> → <why it was not applied: the spec or project requires it, it changes
  behaviour, it widens scope> (or "none")

## Validation

Verification run: `orch verify` run <id> at <HEAD sha>, status passed. With no commit this is the
run from the build, still valid for the same HEAD, which `orch verify` returns as `reused`.
```

`orch` registers `simplify.md` only from a clean worktree and records its HEAD; the review round
judges that commit.

## round-N/review-<reviewer>.md

```markdown
# Review: <reviewer> (round <N>)

## Scope checked

What was examined and how (files, commands run, evidence used). Reviews rely on evidence
actually gathered, not on build.md's claims.

## Findings

- [BLOCKING|MAJOR|MINOR] <file:line> — <what is wrong> → <what to do>
- ...
  (or "No findings.")

## Sensitive changes

For each path in `plan.sensitive` (tests, CI, dependency manifests, verification policy): what
changed in the actual diff, whether a check was added, removed, or weakened, and whether the
effective verification baseline changed. "None" when the plan lists nothing.

VERDICT: PASS
```

`VERDICT: CHANGES` when any BLOCKING or MAJOR finding exists. Only findings inside this
reviewer's ownership and inside the spec's scope; unrelated improvements go under an optional
`## Out of scope (not counted)` heading.

## round-N/consolidated.md

```markdown
# Consolidated findings (round <N>)

## Verdicts

- security: PASS
- correctness: CHANGES
- ...

## Findings

Deduplicated, actionable, in priority order. Each `[BLOCKING]` line ends with the reviewers who
raised it, as `(reviewers: <name>[, <name>...])`.

1. [BLOCKING] <file:line> — <problem> → <fix> (reviewers: correctness, security)
2. [MAJOR] ...
3. [MINOR] ...

## Dropped

Reported but not actionable for this job (out of scope, duplicate, incorrect), with one reason each.

## Sensitive changes

Every path from `plan.sensitive.changes` (orch refuses the file otherwise), why it is sensitive,
whether checks were added, removed, or modified, whether the required verification baseline
changed, and whether human authorization is still needed. "None" when there are none.

BLOCKING: 1
```

`BLOCKING` counts BLOCKING findings only. Zero is written as `BLOCKING: 0`. orch refuses the file
when a `[BLOCKING]` line has no `(reviewers: ...)` tag, when the tag names a reviewer that recorded
no review this round, or when the count of `[BLOCKING]` lines under Findings differs from
`BLOCKING`. Blocking findings are numbered `<round>.<k>`: the k-th `[BLOCKING]` line of the round,
in file order (MAJOR and MINOR lines are not counted, the list's own numbers are ignored). The next
`build.md` answers each one once under `## Findings addressed`, as `- <round>.<k>: fixed` or
`- <round>.<k>: declined — <reason>`; orch refuses it while an id is unanswered or unknown. A scope gap
(something the spec puts in scope that the diff does not implement) is always BLOCKING and is never
dropped, whichever reviewer raised it.

## decision.md

```markdown
# Decision: <Title>

## Examined

- spec.md, build.md, `git diff <baseRef>...HEAD` (<N> files), rounds 1..<K> reviews and
  consolidations, acceptance criteria evidence

## Acceptance criteria

- AC1: verified by <evidence> / not verifiable locally
- ...

## Outstanding findings

<none, or list with severity>

## Scope changes

<none, or what drifted from spec.md>

## Ticket checklist

- [x] <item, copied verbatim from the ticket> — <acceptance evidence>
- [ ] <item, copied verbatim from the ticket> — <reason it is not delivered by this PR>
- [ ] <item, copied verbatim from the ticket> — deferred to <follow-up key>: <why>
- [ ] <item, copied verbatim from the ticket> — does not apply: <why the PR shows it false>

## Rationale

Why this is (not) ready for a human to review as a draft PR.

DECISION: APPROVE
```

`DECISION: REWORK-BUILD` when the code is less than the spec (an acceptance criterion or in-scope
item is not implemented), and `DECISION: REWORK-SPEC` when the spec is less than the request (it
dropped part of what was asked without the request or a human saying so). Name every missing case
under `Scope changes`; the coordinator runs `orch job transition <id> rework`, which sends the job
back to `build` or `spec` once per job and to `needs-human` the second time.
`DECISION: ESCALATE` with the rationale naming the blocking reason otherwise: a blocking finding is
open, scope drifted materially beyond the spec, evidence is missing, or a human must decide.

`## Ticket checklist` is for a job linked to a ticket (`orch ticket show <key> --json`, the
checklist is also in the request): one line per unchecked box in the ticket body, the item text
copied verbatim, then a space, an em dash (—, U+2014), a space, and the evidence or the reason. Write
`none` for a job without a ticket or a ticket without boxes. `orch job transition <id> complete`
in `approve` is refused while an unchecked ticket box is neither ticked in the ticket nor recorded
here as `- [ ] <item> — <reason>`; that line is the enforced record of why it was not delivered.
A box handed to a follow-up ticket is `- [ ] <item> — deferred to <key>[: <why>]` (the reason
starts with exactly `deferred to` and a ticket id such as `0116` or `#116`). The coordinator then
removes the box from the ticket body (or rewrites it as plain text) and notes
`<item>: deferred to <key>` on the ticket; `complete` is refused until both are done and the
follow-up is another open or in-progress ticket, so the original closes on its merge. A box the
PR shows does not apply (its condition is false, its branch was not taken; never work left undone)
is `- [ ] <item> — does not apply: <why>` with a non-empty why. The coordinator removes the box
from the body the same way and runs `orch ticket note <key> "<item>: does not apply: <why>"`;
`complete` is refused until both are done, so the ticket closes on its merge. A reason
worded any other way keeps the box, and the ticket stays open after the merge.

## pr.md (also used as the PR body)

```markdown
# <Title>

Factory job `<jobId>` on `<branch>` → `<baseBranch>`. Spec, build notes, and reviews are in the
job's artifact directory.

## Summary

<2-5 lines>

## Acceptance criteria

- [x] AC1 — <evidence>
- [ ] AC3 — needs human/deployment verification: <how>

## Validation

Verification run <id> at <final HEAD> (after base integration, if any): passed; checks <...>.

## Review

Round <K> of <max>: security PASS, correctness PASS, ... Approver: APPROVE.

## Sensitive changes

Every sensitive path (tests, CI, dependencies, factory.json) with what changed and whether the
verification baseline changed or a human accepted a new policy. "None" when there are none.

## Known limitations

<list, or "none">
```

## pr.md (fast job)

A fast job (`mode: "fast"`) has no spec, review, or approval to report, so its PR body is short.

```markdown
# <Title>

Fast factory job `<jobId>` on `<branch>` → `<baseBranch>` (`orch do --fast`: one agent, no
spec, review, or approval). Ticket <key>.

## Summary

<1-3 lines>

## Changed files

- `<path>` — <why>

## Validation

Verification run <id> at <final HEAD>: passed. Targeted checks: `<command>` → pass, or not run:
<why>.

## Sensitive changes

Every changed test file, or "None" (a fast build that changes factory.json, CI, test
configuration, dependencies, or disables or removes a test is refused).

## Known limitations

<list, or "none">
```

## Harness notes

- Claude Code: `Agent` tool, `subagent_type` = agent name, `model` from the plan. Several `Agent`
  calls in one message run concurrently. Subagents start in the session's cwd, so prompts must
  name the worktree path and ask agents to `cd` into it for every command.
- Other harnesses: paste the agent file body into the prompt; if no subagent tool exists, perform
  the roles yourself sequentially and say so in the report.
