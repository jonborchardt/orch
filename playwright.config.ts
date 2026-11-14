import { defineConfig } from '@playwright/test';

// Browser-level checks against a real `orch ui` serving the built dashboard over seeded data.
// e2e/global-setup.ts seeds a scratch ORCH_HOME and starts the server on a free port (or
// ORCH_E2E_PORT); the spec reads the URL from this run's state file, so concurrent runs on one
// machine never share a port, a database, or a state file. ORCH_E2E_URL points at an external
// server instead.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: process.env['ORCH_E2E_URL'],
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
