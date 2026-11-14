/**
 * Runs before every Vitest file (vitest.config.ts `setupFiles`). Two guarantees for every test,
 * including ones that fail: nothing reaches the developer's real orch data (ORCH_HOME points at a
 * scratch directory for this run, whatever the shell had), and every directory a file created
 * through `tempDir()` is removed when the file finishes.
 */
import { afterAll } from 'vitest';

import { cleanupTempDirs, tempDir } from './helpers.ts';

process.env['ORCH_HOME'] = tempDir('orch-test-home-');
delete process.env['ORCH_TOKEN'];
delete process.env['ORCH_SESSION'];

afterAll(() => {
  cleanupTempDirs();
});
