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

A `process.chdir` to an uppercase drive in the config would not help: the CLI's modules are
already loaded under the lowercase URL.

## Evidence

Reproduction (from the worktree, forward slashes):
`node -e "const r=require('child_process').spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','tests/workflow.test.ts'],{cwd:'c:/<repo>',encoding:'utf8'});console.log(r.stdout)"`

- Before: `FAIL tests/workflow.test.ts`, `Error: Vitest failed to find the current suite`,
  `❯ tests/setup.ts:20:1`, `Test Files 1 failed (1)`, `Tests no tests`. With `C:/<repo>`: `Tests 83 passed (83)`.
- After: `c:/<repo>` and `C:/<repo>` both print `Tests 83 passed (83)`. `npx vitest run` with a
  lowercase cwd on `tests/workflow.test.ts`, `web/src/Tickets.test.tsx`, and `web/src/App.test.tsx`:
  `Tests 224 passed (224)` (before the node_modules part of the fix, the two web files failed with
  `Invalid Chai property`).

## Regression check

`tests/vitest-config.test.ts` (Windows only) spawns the CLI with the repository config from the
lowercase spelling of the checkout on `tests/fixtures/lowercase-drive.test.ts`, which uses
`tests/setup.ts`, a test, and a jest-dom matcher. It fails with the suite error without the plugin.
