import { describe, expect, it } from 'vitest';

import { formatChecks, nodeVersionOk, runDoctor, toolVersion } from '../src/cli/doctor.ts';
import { tempDir } from './helpers.ts';

describe('nodeVersionOk', () => {
  it('compares numerically, not lexically', () => {
    expect(nodeVersionOk('v24.0.0', '24.0.0')).toBe(true);
    expect(nodeVersionOk('v22.18.0', '24.0.0')).toBe(false);
    expect(nodeVersionOk('v24.1.0', '24.0.0')).toBe(true);
    expect(nodeVersionOk('v9.99.99', '24.0.0')).toBe(false);
  });
});

describe('toolVersion', () => {
  it('returns undefined for a missing tool', () => {
    expect(toolVersion('definitely-not-a-real-tool-xyz')).toBeUndefined();
  });

  it('finds git', () => {
    expect(toolVersion('git')).toMatch(/git version/);
  });
});

describe('runDoctor', () => {
  it('reports every check with a known status', () => {
    const checks = runDoctor(process.cwd(), tempDir('orch-doctor-'));
    expect(checks.map((c) => c.name)).toEqual([
      'Node.js',
      'Git',
      'Claude Code',
      'GitHub CLI',
      'Project repository',
      'Install root',
      'Config dir',
      'Data dir',
      'Database',
      'Skills and agents',
    ]);
    for (const c of checks) expect(['ok', 'warn', 'fail']).toContain(c.status);
    expect(formatChecks(checks)).toContain('Node.js');
  });
});
