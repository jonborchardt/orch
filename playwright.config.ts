import { defineConfig } from '@playwright/test';

// Browser-level checks against a real `orch ui` serving the built dashboard over seeded data.
// e2e/global-setup.ts seeds a scratch ORCH_HOME and starts the server; see e2e/dashboard.spec.ts.
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
    baseURL:
      process.env['ORCH_E2E_URL'] ?? `http://127.0.0.1:${process.env['ORCH_E2E_PORT'] ?? '4799'}/`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
