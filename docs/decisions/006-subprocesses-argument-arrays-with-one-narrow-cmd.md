# 6. Subprocesses: argument arrays, with one narrow cmd.exe path (supersedes Phase 1)

Phase 1 ran `execSync('<tool> --version')` through the shell. Phase 2 replaced that with
`src/core/exec.ts`: tool names must match `^[a-z][a-z0-9-]*$`, the executable is resolved on PATH
(honouring PATHEXT) by our own code, and arguments are always arrays. Only `.cmd`/`.bat` shims,
which cannot be started without cmd.exe, go through `cmd.exe /d /s /c` with the resolved absolute
path quoted and arguments restricted to `[\w.=:/-]`. Git is always invoked with `execFileSync` and
an argument array. No shell string is ever built from user input.
