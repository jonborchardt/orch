import { defineConfig } from 'vitest/config';

// Windows, lowercase drive in the cwd (c:\...): Node loads the Vitest CLI and its runner as
// file:///c:/... while Vite resolves packages through realpath as file:///C:/..., so a test's
// `vitest` (directly or through a package such as jest-dom) is a second instance with no current
// suite. Spell resolved node_modules paths with the CLI's drive letter so Node loads one instance.
// docs/decisions/2026-11-24-vitest-lowercase-drive-cwd.md
const cli = process.argv[1] ?? '';
const drive = process.platform === 'win32' && /^[a-z]:/.test(cli) ? cli.slice(0, 2) : undefined;

export default defineConfig({
  plugins: drive
    ? [
        {
          name: 'orch:cli-drive-spelling',
          enforce: 'pre',
          async resolveId(id, importer, options) {
            const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
            if (
              resolved?.id.startsWith(drive.toUpperCase()) &&
              resolved.id.includes('/node_modules/')
            )
              return { ...resolved, id: drive + resolved.id.slice(2) };
            return resolved;
          },
        },
      ]
    : [],
  test: {
    include: ['tests/**/*.test.ts', 'web/src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**'],
    // Per file: a scratch ORCH_HOME and removal of every tempDir() the file created.
    setupFiles: ['tests/setup.ts'],
    // CLI tests spawn many Node processes; Git and verification tests create real repositories
    // and run real subprocesses, and 19 such files run in parallel on Windows. A test that drives
    // three jobs to the ci stage takes 190-240s on a loaded machine, so 180s failed every run.
    testTimeout: 360_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'web/src/**/*.tsx'],
      reporter: ['text', 'lcov'],
    },
  },
});
