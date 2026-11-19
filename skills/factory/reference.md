# Factory reference: agent inputs and artifact templates

`orch` validates every artifact against `src/core/artifact-rules.ts`: required headings
(case-insensitive, any level) and, where shown, exactly one marker line. Copy the templates;
keep the markers as whole lines.

## Agent inputs per stage

Every prompt starts with the header block from SKILL.md. Add:

| Stage      | Agent                     | Extra inputs                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spec`     | `factory-spec-writer`     | The request; issue body if any; "read CLAUDE.md / AGENTS.md / README in the worktree first".                                                                                                                                                                                                                                                                                                     |
| `spec`     | `factory-spec-challenger` | The request; issue body if any; path to `spec.md`; for `spec-review-2.md` the path to `spec-review-1.md`; "read CLAUDE.md / AGENTS.md / README in the worktree first". For the writer's revision: the path to the latest `spec-review-N.md` and "answer its material findings, do not expand scope".                                                                                             |
| `build`    | `factory-builder`         | Path to `spec.md`; round number; for rounds > 1 the path to `round-<N-1>/consolidated.md` and "address every blocking finding, do not expand scope"; validation commands. After a CI rework (`plan.reason` says "CI repair"): the failing check names and the saved log paths under `<artifactDir>/ci/<sha7>/`, and "fix the defect; never weaken checks, tests, CI workflows, or factory.json". |
| `simplify` | `factory-simplifier`      | Paths to `spec.md` and `build.md`, the base ref (`plan.worktree.baseRef`) for `git diff <baseRef>...HEAD`, round number, and the artifact path `round-N/simplify-review.md`; "read only, never edit the worktree".                                                                                                                                                                               |
| `simplify` | `factory-builder`         | Paths to `spec.md`, `build.md`, and `round-N/simplify-review.md`; "apply the findings that make sense, never widen scope, commit if anything changed, run orch verify (it returns the build's run when nothing changed), record each applied and declined finding with its reason"; the artifact path `round-N/simplify.md`.                                                                     |
| `review`   | each `factory-reviewer-*` | Paths to `spec.md`, `build.md`, `round-N/simplify.md`, the evidence dir if one exists, `git diff <baseRef>...HEAD` hint, the base ref (`plan.worktree.baseRef`), round number, and the artifact path.                                                                                                                                                                                            |
| `approve`  | `factory-approver`        | Paths to `spec.md`, `build.md`, every `round-*/review-*.md` and `consolidated.md`, the base ref for the diff, and the round count.                                                                                                                                                                                                                                                               |

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
Logs: `<artifactDir>/verification/<run>/<check>.log`. Exploratory commands you ran beyond that
(with the tail of their output):

- `<targeted test command>` → pass (N tests)
- ...

## Acceptance criteria

- AC1: met — <evidence: test name, screenshot path, command output>
- AC2: ...

## Findings addressed (rounds > 1 only)

- <finding id or text> → <what changed>

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

`VERDICT: CHANGES` when any finding is material. Only `spec-review-1.md` and, after one revision
of `spec.md`, `spec-review-2.md` exist; `orch` binds each to the `spec.md` registered at the time,
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

Deduplicated, actionable, in priority order. Each names the reviewers who raised it.

1. [BLOCKING] <file:line> — <problem> → <fix> (correctness, security)
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

`BLOCKING` counts BLOCKING findings only. Zero is written as `BLOCKING: 0`.

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

## Rationale

Why this is (not) ready for a human to review as a draft PR.

DECISION: APPROVE
```

`DECISION: ESCALATE` with the rationale naming the blocking reason when any acceptance
criterion is unmet, a blocking finding is open, scope drifted materially, or evidence is missing.

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

## Harness notes

- Claude Code: `Agent` tool, `subagent_type` = agent name, `model` from the plan. Several `Agent`
  calls in one message run concurrently. Subagents start in the session's cwd, so prompts must
  name the worktree path and ask agents to `cd` into it for every command.
- Other harnesses: paste the agent file body into the prompt; if no subagent tool exists, perform
  the roles yourself sequentially and say so in the report.
