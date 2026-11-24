# The Session tab reads the tied Claude Code transcripts directly

**Decision.** The job detail's Session tab shows a bounded, read-only tail of the job's Claude Code
transcript and its subagents' transcripts. The dashboard server reads the JSONL files under
`<claude home>/projects/` with `node:fs` (`src/server/transcript.ts`, `GET
/api/jobs/<id>/session-log`). It does not link to or embed afk-viewer. A transcript is tied to a
job only by a session UUID recorded in that job's own `session.attached` events with
`provider: claude-code`; the newest such attachment is read. The `/factory` skill records
`$CLAUDE_CODE_SESSION_ID` with the existing `orch job session attach` after `start` or `resume`,
before the `vscode-agents` attachment. Subagent transcripts are the `agent-<id>.jsonl` files in
`<dir>/<uuid>/subagents/` beside the tied file.

**Why.** Todo 0074 asks for what the owning session is doing, and in a `/factory` job most of
that happens in subagents. afk-viewer reads the same files, but it is a Bun app with no package,
no embed mode, and no URL for one session: a link would land on a generic page that works only if
the user installed and ran it, and embedding it would add a runtime and a dependency. Reading the
files needs no dependency and works on Windows. The project directory is found by listing, not
computed, because Claude Code's directory encoding is lossy (`e--github2-orch` and
`E--github2-orch` both exist). Matching on `cwd` or a checkout claim's `transcript_path` was
rejected: headless sessions share the primary checkout, and claims exist only with the hook and
are released at `SessionEnd`. Neither is a positive tie.

**Exposure and bounds.** Transcripts contain secrets and file contents. The route takes no
parameter that selects a file; every file must resolve, by real path, inside the real `projects`
directory (subagent files also inside their real `subagents/`) and be a regular file. Reads are
tails capped per file, per request, and per meta file; entries, entry text, and the response are
capped; the client renders plain text only. The route is loopback-only behind the detail route's
`Host` and `Sec-Fetch-Site` guards, with `no-store` and `nosniff`. A residual race remains: a
directory on the path swapped to a link out at the open, back at the path check, and out again at
the identity check. It is closed on Linux by resolving the open handle's own path
(`/proc/self/fd/<fd>`) and remains on Windows and macOS, where Node exposes no handle-to-path
call. It needs write access to the user's own Claude projects directory, whose owner can already
read every transcript, so the impact is low (ticket 0086).

**Limits.** The transcript format, `CLAUDE_CODE_SESSION_ID`, and the `subagents/*.meta.json` layout
are Claude Code's and undocumented (observed in 2.1.326); unknown shapes are skipped or give null
fields. Because `finished` may be missing or stale, a subagent reads `running` only when its meta
says `finished: false` and its transcript changed in the last five minutes, else `status unknown`.
Earlier claude-code sessions of a resumed job are listed with `claude --resume`, not read.
A long job can have more subagents than are read; the panel counts the rest. A job driven only
from the Agents window shows an empty tab until its session runs the claude-code attach.
