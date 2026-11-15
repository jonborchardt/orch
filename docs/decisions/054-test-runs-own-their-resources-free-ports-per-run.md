# 54. Test runs own their resources: free ports, per-run state, scratch homes (Phase 2, C02)

**Audit.** Vitest fixtures were already `mkdtemp` directories (stores, repositories, bare origins,
`gh` shims, worktrees under the store's home) and the CLI helper always set `ORCH_HOME`, so two
Vitest runs did not collide on state. Three things were fixed across runs: the Playwright suite
wrote its state to `e2e/.state.json` inside the checkout and listened on 4799 unless
`ORCH_E2E_PORT` said otherwise, so two runs in one checkout fought over both; a test that failed
before its own `rmSync` left its temp directories behind (146 `orch-*` directories were sitting in
this machine's `%TEMP%`); and nothing stopped a test that reached `runtimePaths()` without an
explicit home from opening the developer's database if `ORCH_HOME` happened to be set in the
shell (a second validation campaign on this machine runs with exactly such a shell).

**Decision.** `e2e/global-setup.ts` starts `orch ui` on port 0 (or the pinned `ORCH_E2E_PORT`,
failing with a message naming the port when it is in use rather than connecting to whatever is
already there), reads the URL the server prints, and writes `{home, pid, ids, url}` to a state
file under the run's own scratch home; the path travels to the workers and the teardown as
`ORCH_E2E_STATE`, and the spec sets `baseURL` from it with `test.use`. `ORCH_E2E_KEEP=1` keeps the
home. `tests/setup.ts` runs before every Vitest file: it points `ORCH_HOME` at a scratch
directory and removes every directory the file created through `tempDir()` in `afterAll`, which
Vitest runs after failures as well; a directory held open by an unclosed store is left rather than
fought over. Two concurrent `npx playwright test` runs from one checkout passed with no shared
resource (see the Phase 2 report).

**Left alone.** Playwright's `test-results/` and `playwright-report/` stay where they are: they
are per checkout, the rule is one session per checkout, and moving them would hide the traces
developers look for. A global lock across runs was not needed once nothing was shared.
