# 59. Timed-out verification checks are swept by pid on Windows (Phase 2, C01)

**Confirmed.** `spawnSync` with a `timeout` kills the direct child only. A Node child happens to
take its own children with it (libuv puts them in a job object that dies with the parent), which
is why `node -e` trees collapse in tests, but the real policy shape on Windows is `cmd.exe` in
front of `npm.cmd` in front of Node: the shim dies alone and the test runner, its workers, and any
Git it started keep running, holding files and CPU. Reproduced with a three-level tree behind
`cmd.exe /c`: timeout at 4 s, `cmd.exe` dead, all three Node processes alive.

**Decision.** `spawnCommand` stays synchronous (`verifyJob` and 39 test call sites are sync, and
Ctrl+C on a sync `orch verify` still reaches the check). After a kill (`ETIMEDOUT`, or `ENOBUFS`
from the output cap) on Windows it reads the process table through PowerShell
(`Get-CimInstance Win32_Process`: pid, parent pid, creation time), walks the children of the dead
root (Windows keeps an orphan's parent id pointing at its dead parent, so the tree is still
connected), and terminates every descendant created at or after the check started, with
`process.kill` by pid. The creation-time bound is what makes a reused pid harmless: a process
that merely shares the dead root's number as its parent but predates the check is never touched.
Up to three passes catch processes spawned while a pass ran; `ESRCH` means the process went on its
own, `EPERM` is reported as not terminated. The result (`ToolResult.cleanup`) goes into the check
log, and a tree that was not fully stopped is written into the check's `error` column, so the
evidence says so. Enumeration takes about two seconds and happens only on a kill.

**Rejected.** `taskkill /T` (needs the root alive, which `spawnSync` has already killed; same
parent-link walk underneath); a Job Object (native code); making `spawnCommand` async so the tree
can be killed while the root lives (the ripple through `verifyJob`, the CLI, and every test, for a
cleanup that the post-mortem sweep already achieves); `detached: true` plus a process-group kill
on POSIX (a check in its own session no longer dies with `orch` on Ctrl+C, which is a regression
for the interactive case). POSIX behaviour is therefore unchanged: a shell between `orch` and the
real work still leaves its children on a timeout, as before; orphans are reparented to init there,
so there is no post-mortem link to walk. Killing by executable name was never an option.
