import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

// A lowercase-drive cwd used to load a second `vitest` instance and fail every file with
// "failed to find the current suite" (docs/decisions/2026-11-24-vitest-lowercase-drive-cwd.md).
test.runIf(process.platform === 'win32')(
  'vitest runs from a cwd whose drive letter is lowercase',
  () => {
    const root = path.resolve(import.meta.dirname, '..');
    const cwd = root.charAt(0).toLowerCase() + root.slice(1);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );
    const run = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', 'tests/fixtures/lowercase-drive.test.ts'],
      { cwd, env, encoding: 'utf8' },
    );
    const output = `${run.stdout}${run.stderr}`;
    expect(output).not.toContain('failed to find the current suite');
    expect(run.status, output).toBe(0);
  },
);
