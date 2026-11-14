/**
 * Runs before every test file: whatever `tempDir()` created and the file did not remove itself is
 * removed when the file finishes. Tests still clean up what they can as they go; this catches the
 * directories a test forgot, or that a failure left behind. Set ORCH_KEEP_TEMP=1 to keep them
 * for debugging.
 */
import { rmSync } from 'node:fs';

import { afterAll } from 'vitest';

import { createdTempDirs } from './helpers.ts';

afterAll(() => {
  if (process.env['ORCH_KEEP_TEMP']) return;
  for (const dir of createdTempDirs.splice(0)) {
    try {
      // Windows may still hold a handle from a child process that just exited: retry briefly.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* locked by a process outside this test's control; the next run reports it */
    }
  }
});
