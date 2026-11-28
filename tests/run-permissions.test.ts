/**
 * The controller passes the job's repository its own permission arguments (ticket 0200):
 * `runnerArgsFor` with the job's identity. Uses tests/run-fixture.ts; nothing reaches the network.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_RUNNER_CLAUDE_ARGS } from '../src/core/roles.ts';
import { configPath } from '../src/ops/factory.ts';
import { done, launcher, one, store, ticket } from './run-fixture.ts';

describe('session permissions', () => {
  it('adds the rules scoped to the job repository and none scoped to another', async () => {
    const file = configPath(store);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({
        ...raw,
        extraAllowedTools: ['Bash(make *)'],
        repoAllowedTools: {
          'github.com/acme/alpha': ['Bash(pnpm *)'],
          'github.com/acme/beta': ['Bash(cargo *)'],
        },
      }),
    );
    const l = launcher(done);
    await one(l, ticket('Needs pnpm'));
    expect(l.calls[0]?.args).toEqual([
      ...DEFAULT_RUNNER_CLAUDE_ARGS,
      'Bash(make *)',
      'Bash(pnpm *)',
    ]);
    expect(l.calls[0]?.args).not.toContain('Bash(cargo *)');
  });
});
