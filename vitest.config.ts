import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**'],
    // CLI tests spawn many Node processes; Git tests create real repositories.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'web/src/**/*.tsx'],
      reporter: ['text', 'lcov'],
    },
  },
});
