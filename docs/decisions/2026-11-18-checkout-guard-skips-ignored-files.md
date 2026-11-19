# The checkout guard skips files Git ignores

**Decision.** `hookCheckout` (`src/ops/checkout.ts`) ignores a PreToolUse write whose file
`git check-ignore` reports as ignored: it neither claims the checkout nor is refused while another
session holds it.

**Why.** The lease (decision 60) exists because two sessions editing one checkout corrupt each
other's commits and test runs. An ignored file is in no commit. The private `todo/` register lives
only in the primary checkout, and a session that drives a factory job from there (the `dotodo`
skill) must be able to update a todo's status while another session holds that checkout.

**Limits.** Ignored build output (`dist/`, `node_modules/`) can still affect another session's
test run; those are written by tools through the shell, which the guard never saw. A session that
only writes ignored files never claims the checkout.
