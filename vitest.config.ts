import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**'],
    // Per file: a scratch ORCH_HOME and removal of every tempDir() the file created.
    setupFiles: ['tests/setup.ts'],
    // CLI tests spawn many Node processes; Git and verification tests create real repositories
    // and run real subprocesses, and 19 such files run in parallel on Windows.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'web/src/**/*.tsx'],
      reporter: ['text', 'lcov'],
    },
  },
});
