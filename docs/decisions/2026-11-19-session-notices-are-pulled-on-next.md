# Session notices are pulled on `next`

**Decision.** A single job runs `/factory` in the interactive session; headless `claude -p`
sessions and dispatch are for several jobs at once. A running session learns of outside events
from `plan.notices` on its next `orch factory next|status`: derived notices (base moved, PR
merged, cancelled, fetch failed) are recomputed from state on every call, and posted messages are
`notice.posted` events shown until the owner records `notice.acked { through }`. Only `next` and
`status` fetch the base (`planJobFresh`, 15 s limit, skipped without `origin`); every other reader
calls `planJob`, which never fetches. The ack is `plan.noticeAck`, not an entry in
`plan.commands`.

**Why.** When the verification fix landed on `main`, a headless job session could not be told: it
was killed and relaunched, and the human saw nothing meanwhile. `orch` stays one-shot and never
messages a session (decision 2026-11-16-opt-in-recovery-worker), and the skill loop already calls
`next` after every step, so a pulled notice reaches the session without a daemon or a push.
Posting needs no token because the poster (a human, the dashboard's prompt box later) is not the
owner; it changes no revision or lease, like the mail writes. Acknowledging is an explicit owner
command so that `next` stays read-only. Keeping the ack out of `plan.commands` leaves every reader
of `commands[n]` unchanged.

**Limits.** Delivery is only as prompt as the session's next `orch` call; a session inside a long
subagent or `orch verify` sees the notice afterwards. Any local process can post; the skill treats
a message as an instruction within the job's scope, never as permission to widen it or skip a
gate.
