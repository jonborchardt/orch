/**
 * Runs before every Vitest file (vitest.config.ts `setupFiles`). Two guarantees for every test,
 * including ones that fail: nothing reaches the developer's real orch data (ORCH_HOME points at a
 * scratch directory for this run, whatever the shell had), and every directory a file created
 * through `tempDir()` is removed when the file finishes.
 */
import { afterAll } from 'vitest';

import { cleanupTempDirs, tempDir } from './helpers.ts';

process.env['ORCH_HOME'] = tempDir('orch-test-home-');
// The Session tab reads `<claude home>/projects/`: never the developer's real transcripts.
process.env['CLAUDE_CONFIG_DIR'] = tempDir('orch-test-claude-');
delete process.env['ORCH_TOKEN'];
delete process.env['ORCH_SESSION'];
// Never send real mail: a test that wants mail configures the fake server itself.
for (const key of Object.keys(process.env))
  if (key.startsWith('MAIL_')) Reflect.deleteProperty(process.env, key);

afterAll(() => {
  cleanupTempDirs();
});
