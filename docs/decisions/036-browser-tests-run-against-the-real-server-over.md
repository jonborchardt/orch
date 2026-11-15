# 36. Browser tests run against the real server over seeded fixtures

`tests/fixtures/dashboard.ts` builds representative state through the storage API (a live job, a
stale one, a human-blocked one, multiple rounds with long findings, a completed PR with failing CI,
a cancelled job, a fresh one). API tests start `startServer` in-process; component tests render the
React app in jsdom against a mocked `fetch`; Playwright drives Chromium against `orch ui` serving
`web/dist` from a scratch `ORCH_HOME`. CI runs Playwright on Linux only to keep the Windows job
fast; `npm run check` does not need a browser.
