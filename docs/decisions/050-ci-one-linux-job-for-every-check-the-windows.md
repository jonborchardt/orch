# 50. CI: one Linux job for every check, the Windows suite split across runners

**Measured.** Hosted runners for this private repository have 2 cores, so Vitest's default worker
count (cores - 1) ran all 22 files on one worker: per-file durations summed to the wall clock on
both platforms. Windows Vitest was 16 of the 18 minutes of a PR run; every other step together was
under two minutes. On Windows, 2 workers doubled each file's duration and gained nothing, and 3
workers gained about a quarter while tripling per-test times (the suite spawns Git and Node for
nearly every assertion, and process creation is what the two cores spend their time on). On Linux,
3 workers cut the suite from 3m14s to 2m12s.

**Decision.** Platform-independent checks (typecheck, lint, format, migration drift, coverage,
Playwright) run once, on Ubuntu, where they were already fastest. Windows runs the whole Vitest
suite, because the slow files are exactly the Git, worktree, path, and process tests that have
found real Windows defects; they are split across four runners by explicit groups of measured
duration (`ci` alone, `factory` + `integration`, `audit` + `verify` + `sensitive`, and the rest via
`--exclude`), each on Vitest's default single worker. The rest group also builds and smoke-tests the
CLI from `dist/`. A new test file runs in the rest group until someone rebalances. Vitest's own
`--shard` was rejected: it distributes by path hash and put 60% of the Windows time in one shard.
The critical path after the change is `tests/ci.test.ts` alone (about five minutes on Windows);
splitting that file is the next lever, not more workers.

**Found on the way.** With 3 Windows workers, `tests/install.test.ts` once reported no conflict for
a user file. `sameFile` compared `stat().ino` as doubles; NTFS file ids are 64-bit and lose low
bits above 2^53, so two files created back to back can compare equal and a conflicting agent file
passes as a hard link. It now compares bigint stats. The flake was latent, not caused by the
workflow change.
