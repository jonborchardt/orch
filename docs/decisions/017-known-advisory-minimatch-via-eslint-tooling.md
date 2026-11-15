# 17. Known advisory: `minimatch` via ESLint tooling

`npm audit` reports a moderate DoS advisory in `minimatch` 7–11.0.0 reached through `eslint@10` and
`typescript-eslint@8`. Both are at their latest versions and still depend on `minimatch@10`; the
only "fix" npm offers is a downgrade to ESLint 9. The dependency is dev-only (lint-time glob
matching of our own config) and never shipped, so it is documented here and left alone until the
tooling moves to `minimatch >= 11.0.1`. (Rechecked 2026-11-13: still the only advisory, now
reported as 10 moderate entries that are all this one `minimatch` range reached through
`eslint@10`, `@eslint/config-array`, and `typescript-eslint@8`; `npm audit fix --force` would
downgrade to ESLint 9. Unchanged decision.)
