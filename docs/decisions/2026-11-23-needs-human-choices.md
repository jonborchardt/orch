# Needs-human choices are existing dashboard actions, kept on the job.blocked event

**Decision.** A session that escalates may offer the human one to five answers with
`orch job transition <id> escalate --choice "<kind>[:<stage>]=<label>"` (ticket 0057). Each kind
is one existing dashboard decision: `resume:<stage>` (Resume at), `rework`, `review`,
`accept-delivery`, `cancel`. There is no new transition and no free-form instruction to the next
agent. The choices are stored on the `job.blocked` event payload, not in a column, so no schema
change was needed. They count only from the newest `job.blocked` event while the job is in
`needs-human` (`currentChoices` in `src/ops/actions.ts`, the one reader), so escalating again
replaces them.

The dashboard's `answer` action takes a choice index and an optional note. It re-reads the choices
inside the lease and runs exactly the mapped action, with that action's refusals. The note goes
into the recorded reason and, when the job is still unfinished, into a posted notice, which is how
the answer reaches the session that continues the job. Nothing starts a session.

A fast job's escalate is refused (`WorkflowError`, exit 1) when a `resume` choice names a stage
outside its resume targets. This check is in the pure `transition`, which has the mode. The parser
sees only the strings and refuses syntax (`UsageError`, exit 2).

**Rationale.** Mapping onto existing actions keeps every rule in one place: an answer cannot do
anything a human clicking the matching control could not. A job's mode is fixed at creation, so
checking reachability at record time means the dashboard never shows a button that can never work.
The notice is posted after the transition, outside its transaction. If posting fails, the note is
still in the event reason. A storage function writing both in one transaction would close that gap
if it ever matters.
