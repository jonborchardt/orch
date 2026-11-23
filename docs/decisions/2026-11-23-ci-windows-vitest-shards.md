# CI: the Windows suite runs as six Vitest shards, with no hand-kept groups

**Decision.** The `windows` job in `.github/workflows/ci.yml` is a matrix of six identical jobs,
`windows (1/6)` to `windows (6/6)`, each running `npx vitest run --shard=<i>/6`. The workflow names
no test file: no `files:` list, no `--exclude`, no "everything else" group. Shard 3 also builds and
smoke-tests the CLI from `dist/`. `vitest.config.ts` is unchanged: Vitest's default sequencer
assigns files. This partly supersedes decision 50: its split of the Linux and Windows work stands,
its four (later five) hand-named Windows groups and its rejection of `--shard` do not.

**Why.** The hand-named groups had a catch-all, `rest`, that every new test file joined. By PRs
122 to 124 it ran 18 to 19 minutes while every other job took 3 to 8, so CI wall-clock was that one
job. Decision 50 rejected `--shard` because path-hash assignment put 60% of the Windows time in one
shard; that was with 22 files, a few of them five minutes long. With 96 files of which the slowest
is about 5% of the total, the same assignment spreads evenly enough: on the measured per-file
durations the slowest of six shards holds 22% of the time (an even split is 17%). Vitest's default
`shard` sorts the files by a SHA-1 of their path and cuts equal file counts, so every file is in
exactly one shard, and adding a file moves each shard boundary by at most one file. Shard 3 carries
the smoke step because it was the lightest on these figures; any one shard would do.

Balancing by file size in a custom sequencer was tried on the same figures and is worse than the
hash (slowest of six 25%, with a 174 s shard next to a 1060 s one: `web/src/App.test.tsx` is the
largest file and among the fastest), so it was not added. Six rather than five: five puts an
estimated 6 min 7 s of Vitest in the slowest shard, about 7 min 30 s with setup, which is close to
1.5 times a fast `check` job (5 min 19 s on PR 125); six brings it to about 7 min. More runners add
about 80 s of checkout, `npm ci` and setup each, so total runner minutes rise a little while
wall-clock falls.

If one shard later becomes much slower than the rest (one very slow new file can do it), split the
file, as decision 50 already says, or raise the shard count; do not go back to named groups.

## Coverage check

Run in the job worktree at the branch's base (c88c6f9), 2026-11-23: for i = 1..6,
`npx vitest run --shard=i/6 -t '^no-such-test-0122$' --passWithNoTests --reporter=json` (files are
collected and every test skipped; `vitest list` ignores `--shard`), and the same without `--shard`.
Each shard listed 16 files; the union is the unsharded 96 files, none in two shards, none missing,
none extra.

## Measurements

Each figure is labelled **measured** (read from a clock or a log) or **computed** (arithmetic on
measured figures). Run times are from `gh run view <id> --json createdAt,updatedAt,jobs` (created,
and the last job's completion); job times from each job's `startedAt` and `completedAt`.

### Before

| Figure                                    | Value                | Kind     | Source                                                                                                                                               |
| ----------------------------------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 122 CI wall-clock                      | 19 min 16 s (1156 s) | measured | run 45110513596, attempt 1, ba2200f: created 04:13:20Z, last job done 04:32:36Z                                                                      |
| PR 122 `windows (rest)`                   | 1152 s               | measured | same run, 04:13:23Z-04:32:35Z; `check` 373 s (04:13:23Z-04:19:36Z)                                                                                   |
| PR 123 CI wall-clock                      | 19 min 16 s (1156 s) | measured | run 45115812419, attempt 1, 745776d: created 05:07:30Z, last job done 05:26:46Z                                                                      |
| PR 123 `windows (rest)`                   | 1153 s               | measured | same run, 05:07:33Z-05:26:46Z; `check` 368 s (05:07:33Z-05:13:41Z)                                                                                   |
| PR 124 CI wall-clock                      | 18 min 14 s (1094 s) | measured | run 45121546863, attempt 1, f49706f: created 06:02:57Z, last job done 06:21:11Z                                                                      |
| PR 124 `windows (rest)`                   | 1089 s               | measured | same run, 06:03:01Z-06:21:10Z; `check` 482 s (06:03:00Z-06:11:02Z)                                                                                   |
| PR 125 CI wall-clock                      | 16 min 30 s (990 s)  | measured | run 45135022232, attempt 1, 8375ea4: created 07:58:53Z, last job done 08:15:23Z; `windows (rest)` 987 s, `check` 319 s, other Windows jobs 174-314 s |
| PR 125 Windows Vitest, all groups         | 1525.9 s             | computed | sum of the five groups' Vitest `Duration` lines in run 45135022232's job logs (114.43 + 157.32 + 897.10 + 222.28 + 134.74 s)                         |
| PR 125 Windows per-file durations, summed | 4217.3 s             | computed | sum of the 96 per-file durations in the same logs; files overlap on a runner's workers, so this is 2.76 times the Vitest wall time                   |
| PR 125 `windows (rest)` setup             | 78 s                 | measured | job start 07:58:56Z to the Vitest step 08:00:14Z (checkout, setup-node, `npm ci`)                                                                    |

### After, estimated before the first run

| Figure                                   | Value                          | Kind     | Source                                                                           |
| ---------------------------------------- | ------------------------------ | -------- | -------------------------------------------------------------------------------- |
| Per-file duration per shard (1/6 to 6/6) | 626, 801, 457, 914, 497, 922 s | computed | PR 125 per-file durations summed over each shard's files from the coverage check |
| Slowest shard's Vitest time              | about 334 s                    | computed | 922 s / 2.76                                                                     |
| Slowest shard job                        | about 7 min (about 422 s)      | computed | 334 s + 78 s setup + about 10 s after Vitest                                     |

### After, this PR's CI run

Pending: the PR's first CI run does not exist when this file is written. It is recorded here in a
follow-up commit on the branch from `gh run view <id> --json createdAt,updatedAt,jobs`: run id,
attempt, created and last-job-done times, total wall-clock, and every job's duration.

| Figure          | Value   | Kind     | Source |
| --------------- | ------- | -------- | ------ |
| CI wall-clock   | pending | measured |        |
| `check`         | pending | measured |        |
| `windows (1/6)` | pending | measured |        |
| `windows (2/6)` | pending | measured |        |
| `windows (3/6)` | pending | measured |        |
| `windows (4/6)` | pending | measured |        |
| `windows (5/6)` | pending | measured |        |
| `windows (6/6)` | pending | measured |        |

**Required checks.** `main` has no branch protection (`gh api
repos/jonborchardt/orch/branches/main/protection/required_status_checks`: 404 "Branch not
protected") and no ruleset (`gh api repos/jonborchardt/orch/rules/branches/main`: `[]`), checked
2026-11-23, so no required check names an old Windows job.
