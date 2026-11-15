# 16. Ownership by lease with explicit renewal

There is no daemon to renew leases, so: `claim` records the session, a random token, and
`leaseExpiresAt = now + leaseMinutes` (default 30). Every successful mutation by the token holder
renews the lease by the same length; `claim` by the same session renews explicitly. A different
session may claim only after expiry (or with `--force`), which rotates the token so the previous
owner's commands fail with exit 4, and marks a `running` job `interrupted`. (Since decision 38
every claim rotates the token, same session or not.) `--revision <n>` adds
optimistic concurrency for callers that want to reject any intervening change.
