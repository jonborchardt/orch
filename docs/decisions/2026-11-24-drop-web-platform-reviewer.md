# Drop the web-platform reviewer; ui-design checks bundle size and browser APIs

Ticket 0141. The `web-platform` role is removed from `ROLES` and its agent
(`agents/factory-reviewer-web-platform.md`) is deleted. UI jobs now plan three UI reviewers:
`ui-design`, `ux`, and `accessibility`. The one web-platform check worth keeping moves into the
ui-design reviewer's ownership: flag a large jump in bundle size (a new heavy dependency or import)
or a misused browser API.

## Rationale

In 65 recorded runs the web-platform reviewer returned PASS every time. Its remaining ownership
(caching, network behaviour, browser compatibility, rendering performance) matters little for a
dashboard served on loopback only, so it cost a reviewer run per UI round for no findings.

## Consequences

- Existing `reviews` rows and `round-N/review-web-platform.md` artifacts are kept as they are; job
  detail rounds and `orch job usage` iterate stored rows, so they still show them (configured model
  `null`). The dashboard Agents section lists only current roles, so it no longer has a
  web-platform row. No schema change or data migration.
- A `factory.json` with `models["web-platform"]` is now rejected as an unknown role; remove the key.
- `orch install` never prunes removed agents: an existing
  `~/.claude/agents/factory-reviewer-web-platform.md` link or managed copy stays until a person
  deletes it. Nothing plans it, so it is harmless.
