# A rebuilt controller hands its session to the new build in the foreground

**Decision.** When the factory controller halts on `orch-rebuilt` (decision
[2026-11-25-environment-stops-are-resumable](2026-11-25-environment-stops-are-resumable.md)), it
first ends its session exactly as before: unfinished, ticket and job in flight, the job untouched
and unowned, the slot lock released. Then `orch start`, `orch do`, or `orch resume` runs the
installed build's `orch resume` for the same slot as a foreground child in the same terminal
(`handOff` in `src/ops/run.ts`, `runForeground` in `src/core/exec.ts`): `process.execPath` with
`dist/cli/main.js` under `installRoot()`, an argument array, inherited stdio, never detached, no
shell. `--repo <path>` names a scoped slot (the queue's path, or `orch do`'s ticket checkout);
`--json` is passed on, and the parent's own summary then goes to stderr so stdout is the child's
one object. The parent waits and exits with the child's code (1 when a signal ended it). A SIGINT
reaching the parent keeps it alive until the child exits and is forwarded on POSIX; on Windows the
console already delivers Ctrl-C to the child, and `kill('SIGINT')` there would end it without its
resumable stop, so nothing is sent.

Bounded: a child that exits non-zero within `HANDOFF_REFUSAL_MS` (10 s; a bad build, a person's
own `orch resume` that took the slot first, an ambiguous slot) is reported as a refused handoff and
the parent exits with that code, leaving the session for `orch resume`. Nothing retries. The
parent hands off once, after its session returned; whatever the child's own run does (including
its own `orch-rebuilt` halt and handoff) is the child's. `bad-config` and `usage-limit` stops are
unchanged.

This supersedes "Reloading or re-executing the controller was left out" in the 2026-11-25
decision, which is kept as written.

**Why.** Rebuilding to pick up a merged fix is routine, and each time the run sat until a person
typed `orch resume` (2026-11-26, three times). The child is exactly that command, so it changes
nothing a person's `orch resume` would not: it takes the released lock, writes its own PID into the
session, and owns the stop files, so `orch stop`, `orch stop next`, and `orch status` see it.

It is still one controller in one terminal, and not "starting the controller from another
command". The lock passes through release and acquire, so at no moment do two processes hold the
slot; the parent drives nothing after the release, writes no session or stop file, and only waits
in the foreground on its child; nothing is detached, so closing the terminal or Ctrl-C ends both.
It is the same command continuing under the new code, the way a person would continue it by hand,
and it starts an `orch resume`, never a Claude process: `launchClaude` stays the only way a Claude
child starts. Re-executing in place without a waiting parent was not taken: Node has no portable
`exec`, and on Windows the terminal would lose its foreground process.

Each rebuild during a run nests one more waiting process (one level per rebuild); that is accepted.
