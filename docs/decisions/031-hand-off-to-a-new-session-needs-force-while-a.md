# 31. Hand-off to a new session needs `--force` while a lease is live

`orch factory resume` by a different session is refused while the owner's lease has not lapsed,
including for jobs waiting in `needs-human`. The human (or the new session on their instruction)
passes `--force`, which rotates the token. Silent takeover would let two live sessions race on one
job; a lapsed lease is taken over without ceremony because its holder is presumed gone.
