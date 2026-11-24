# Vitest from a lowercase-drive cwd loads one Vitest instance

Ticket 0103. On Windows, `vitest run` failed every file with `Vitest failed to find the current
suite` at `tests/setup.ts:20` (`afterAll`) when the process cwd had a lowercase drive letter
(`c:\...`, `e:\...`), as Claude Code's Bash tool can start with. Git Bash itself is not the trigger:
`cd /e/github2/orch` hands Node `E:\github2\orch` and passes. No Git Bash-specific variable or MSYS
path conversion was involved.

## Cause (confirmed)

Node keys ES modules by URL, and the URL's drive letter is case-sensitive. Two spellings of the same
`node_modules/vitest/dist` met in one worker:

- The CLI, its pool, the worker, and the runner come from `process.argv[1]`, which Node resolves
  against the cwd without canonicalizing case: `file:///c:/.../node_modules/vitest/dist/chunks/run.*.js`.
- Vite resolves bare imports in test code through `realpathSync.native`, which uppercases the drive:
  `vitest` in `tests/setup.ts` became `file:///C:/.../node_modules/vitest/dist/index.js`. Node loads
  it as a second instance whose collector has no current suite. A package imported by tests
  (`@testing-library/jest-dom/vitest`) has the same problem: Node resolves its own `vitest` import
  from its `C:` location, so its matchers land on the wrong `expect`
  (`Invalid Chai property: toHaveAttribute`).

Shown by a probe setup file: `import.meta.resolve('vitest')` was `file:///C:/...` while the stack's
`runSetupFiles` frame was `file:///c:/...`. Vitest 5.1.1 lists no fix for this.

## Fix

`vitest.config.ts` adds a `resolveId` plugin, active only on Windows when `process.argv[1]` starts
with a lowercase drive: any resolved id under `node_modules` gets the CLI's drive spelling. Node then
loads `vitest` (directly or through a package) from the same URL as the runner. Project files are
left as Vite resolves them. Uppercase cwds, PowerShell, and Linux CI get no plugin.

## Evidence

`vitest run tests/workflow.test.ts` from `c:/<repo>`, before: `Error: Vitest failed to find the
current suite` at `tests/setup.ts:20:1`, `Tests no tests`. After: `Tests 83 passed (83)`, same as
from `C:/<repo>`. `tests/vitest-config.test.ts` reproduces this on Windows.
