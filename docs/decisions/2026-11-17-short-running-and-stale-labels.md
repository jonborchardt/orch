# Short running and stale labels

**Decision.** The dashboard status chip reads `running` where it read `running (lease live)`, and
`stale` where it read `last reported running`. The lease explanation moves into the chip's tooltip
(`STATE.describe` in `web/src/format.ts`), which the detail view also prints as text. `running` is
still shown only when `liveness()` in `src/server/status.ts` returns `running` (status `running`,
lease not expired), and `stale` only when it returns `stale` (status `running`, lease expired).
The `stale` wording says the session may no longer be working or may only have missed a renewal;
it never claims the session ended.

**Why.** The short labels match the app bar's `n stale` summary chip and the `stale` Show filter,
and fit the status column. The guarantee of `034-liveness-is-reported-not-inferred.md`, that a
lapsed lease never reads as running, is unchanged: a lapsed lease reads `stale`. This decision
supersedes only the label wording quoted in decision 34; its rule stands. Keeping the verbose
labels and only adding tooltips was rejected because todo 0032 chose the short labels.

**Limits.** The tooltip is a native `title`, so keyboard and touch users rely on the detail view's
text for the full meaning.
