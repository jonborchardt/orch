import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installRoot, packageInfo } from '../src/core/paths.ts';

/** Run the CLI from source, outside the repository, to prove cwd independence. */
function orch(...args: string[]) {
  const r = spawnSync(process.execPath, [join(installRoot(), 'src', 'cli', 'main.ts'), ...args], {
    cwd: tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, ORCH_HOME: join(tmpdir(), 'orch-test-home') },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('orch CLI', () => {
  it('--version prints the package version', () => {
    const r = orch('--version');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(packageInfo().version);
  });

  it('--help prints usage', () => {
    const r = orch('--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: orch');
  });

  it('no command prints usage and exits 2', () => {
    expect(orch().code).toBe(2);
  });

  it('unknown command exits 2', () => {
    const r = orch('bogus');
    expect(r.code).toBe(2);
    expect(r.err).toContain('Unknown command: bogus');
  });

  it('doctor runs outside a repository and reports the override home', () => {
    const r = orch('doctor');
    expect(r.out).toContain('Node.js');
    expect(r.out).toContain('orch-test-home');
    expect(r.out).toContain('not inside a Git repository');
  });
});
