# CI: the Windows suite runs as six Vitest shards, with no hand-kept groups

**Decision.** The `windows` job in `.github/workflows/ci.yml` is a matrix of six identical jobs,
`windows (1/6)` to `windows (6/6)`, each running `npx vitest run --shard=<i>/6`. The workflow names
no test file: no `files:` list, no `--exclude`, no "everything else" group. Shard 3 also builds and
smoke-tests the CLI from `dist/`. `vitest.config.ts` is unchanged: Vitest's default sequencer
assigns files. This partly supersedes decision 50: its split of the Linux and Windows work stands,
its four (later five) hand-named Windows groups and its rejection of `--shard` do not.

**Why.** The hand-named groups had a catch-all, `rest`, that every new test file joined. By PR
122 it ran 19 minutes while every other job took 3 to 8, so CI wall-clock was that one job.
Decision 50 rejected `--shard` because path-hash assignment put 60% of the Windows time in one
shard; that was with 22 files, a few of them five minutes long. With 96 files of which the slowest
is about 5% of the total, the same assignment spreads evenly enough: on the measured per-file
durations the slowest of six shards holds 22% of the time (an even split is 17%). Vitest's default
`shard` sorts the files by a SHA-1 of their path and cuts equal file counts, so every file is in
exactly one shard, and adding a file moves each shard boundary by at most one file. Shard 3 carries
the smoke step because it was the lightest on these figures; any one shard would do. Hash balance
is good enough at 96 files, so no custom sequencer. Six shards keep the slowest job near `check`:
on PR 125's per-file durations (run 45135022232) the slowest shard holds 922 s of per-file time,
about 334 s of Vitest (per-file sums run 2.76 times Vitest wall time), so about 7 min with 78 s of
setup.

If one shard later becomes much slower than the rest (one very slow new file can do it), split the
file, as decision 50 already says, or raise the shard count; do not go back to named groups.

## Coverage check

Run in the job worktree at the branch's base (c88c6f9), 2026-11-23: for i = 1..6,
`npx vitest run --shard=i/6 -t '^no-such-test-0122$' --passWithNoTests --reporter=json` (files are
collected and every test skipped; `vitest list` ignores `--shard`), and the same without `--shard`.
Each shard listed 16 files; the union is the unsharded 96 files, none in two shards, none missing,
none extra. On this PR's CI run 45141920755 each of the six shard jobs reported "Test Files 16
passed (16)" and `check` reported 96, so 6 × 16 = 96 files ran on Windows.

## Measurements

Each figure is labelled **measured** (read from a clock or a log) or **computed** (arithmetic on
measured figures). Run times are from `gh run view <id> --json createdAt,updatedAt,jobs` (created,
and the last job's completion); job times from each job's `startedAt` and `completedAt`.

### Before

| Figure                  | Value                | Kind     | Source                                                                                                                                               |
| ----------------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 122 CI wall-clock    | 19 min 16 s (1156 s) | measured | run 45110513596, attempt 1, ba2200f: created 04:13:20Z, last job done 04:32:36Z                                                                      |
| PR 122 `windows (rest)` | 1152 s               | measured | same run, 04:13:23Z-04:32:35Z; `check` 373 s (04:13:23Z-04:19:36Z)                                                                                   |
| PR 123 CI wall-clock    | 19 min 16 s (1156 s) | measured | run 45115812419, attempt 1, 745776d: created 05:07:30Z, last job done 05:26:46Z                                                                      |
| PR 123 `windows (rest)` | 1153 s               | measured | same run, 05:07:33Z-05:26:46Z; `check` 368 s (05:07:33Z-05:13:41Z)                                                                                   |
| PR 124 CI wall-clock    | 18 min 13 s (1093 s) | measured | run 45121546863, attempt 1, f49706f: created 06:02:57Z, last job done 06:21:10Z                                                                      |
| PR 124 `windows (rest)` | 1089 s               | measured | same run, 06:03:01Z-06:21:10Z; `check` 482 s (06:03:00Z-06:11:02Z)                                                                                   |
| PR 125 CI wall-clock    | 16 min 30 s (990 s)  | measured | run 45135022232, attempt 1, 8375ea4: created 07:58:53Z, last job done 08:15:23Z; `windows (rest)` 987 s, `check` 319 s, other Windows jobs 174-314 s |

### After, this PR's CI run

Run 45141920755, attempt 1, PR 126 at 19794cf: the run for the commit before the one that records
it (this commit starts another run, not recorded here). Every job succeeded.

| Figure                  | Value              | Kind     | Source                                                      |
| ----------------------- | ------------------ | -------- | ----------------------------------------------------------- |
| CI wall-clock           | 6 min 49 s (409 s) | computed | created 08:50:55Z, last job done 08:57:44Z (both measured)  |
| `check`                 | 394 s              | measured | 08:50:58Z-08:57:32Z                                         |
| `windows (1/6)`         | 384 s              | measured | 08:50:59Z-08:57:23Z                                         |
| `windows (2/6)`         | 406 s              | measured | 08:50:58Z-08:57:44Z                                         |
| `windows (3/6)`         | 191 s              | measured | 08:50:59Z-08:54:10Z, includes the build and smoke step      |
| `windows (4/6)`         | 349 s              | measured | 08:51:02Z-08:56:51Z                                         |
| `windows (5/6)`         | 185 s              | measured | 08:50:59Z-08:54:04Z                                         |
| `windows (6/6)`         | 374 s              | measured | 08:50:59Z-08:57:13Z                                         |
| Slowest shard / `check` | 406 / 394 = 1.03   | computed | `windows (2/6)` against `check`; the limit is 1.5           |
| Wall-clock change       | 1156 s to 409 s    | computed | PR 122 and PR 123 before, this run after: about 65% shorter |

**Required checks.** `main` has no branch protection (`gh api
repos/jonborchardt/orch/branches/main/protection/required_status_checks`: 404 "Branch not
protected") and no ruleset (`gh api repos/jonborchardt/orch/rules/branches/main`: `[]`), checked
2026-11-23, so no required check names an old Windows job.
