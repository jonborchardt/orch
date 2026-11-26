# A needs-human choice link opens its confirm dialog and does nothing else

**Decision.** The status mail, the controller's needs-human stop line, its end-of-session summary,
and `orch status` lead a job waiting in needs-human with what is needed (one plain sentence) and
one line per choice: its label, what picking it does, and the link
`http://127.0.0.1:4777/#/jobs/<id>?choose=<n>`, where `n` is the choice's index in
`currentChoices`, the index the `answer` action takes (ticket 0174). All of them, and the job
page, read `needsHuman` in `src/ops/actions.ts`, built on `currentChoices`; none reads the
`job.blocked` payload itself. The link is a hash route: loading it renders the job page with that
choice's existing confirm dialog open, and only its Confirm posts `answer`, through the same
Host/Origin/CSRF guards as any click. A choice whose action is not allowed now is printed without a
link; an out-of-range or unavailable index opens no dialog. The port is `DEFAULT_PORT`.

**Why.** A person reads the mail or the terminal first, and the escalation there said only
"Decide on the dashboard: approve, cancel". A link per choice gets them to the decision in one
click without making a GET act: a mailed link can be prefetched or opened by mistake, and a stale
one (the job escalated again) is caught by the dialog showing the current label and the server's
existing "escalated again with other choices" refusal. No token in the link, no new route, no
recorded port: a dashboard on another port or not running leaves the link dead, and the mail keeps
its "run orch ui" line.
