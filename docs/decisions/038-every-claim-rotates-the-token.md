# 38. Every claim rotates the token

Session names are chosen by the caller, so a second process resuming under the same name used to
receive the same token and both could drive the job. A claim now always issues a fresh token; the
previous holder fails with exit 4 on its next command. "Resume" therefore means "take over from
whoever had this name", which is the only safe reading when there is no process registry.
