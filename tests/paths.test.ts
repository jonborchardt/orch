import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findProjectRoot, installRoot, packageInfo, runtimePaths } from '../src/core/paths.ts';

describe('runtimePaths', () => {
  it('honours ORCH_HOME override on any platform', () => {
    const p = runtimePaths({ ORCH_HOME: '/x/orch' }, 'linux', '/home/u');
    expect(p).toEqual({
      config: '/x/orch',
      data: '/x/orch',
      logs: join('/x/orch', 'logs'),
      tmp: join('/x/orch', 'tmp'),
    });
  });

  it('uses APPDATA / LOCALAPPDATA on Windows', () => {
    const p = runtimePaths(
      { APPDATA: 'C:\\U\\Roaming', LOCALAPPDATA: 'C:\\U\\Local' },
      'win32',
      'C:\\U',
    );
    expect(p.config).toBe(join('C:\\U\\Roaming', 'orch'));
    expect(p.data).toBe(join('C:\\U\\Local', 'orch'));
    expect(p.logs).toBe(join('C:\\U\\Local', 'orch', 'logs'));
  });

  it('falls back to home-relative dirs on Windows without env', () => {
    const p = runtimePaths({}, 'win32', 'C:\\U');
    expect(p.data).toBe(join('C:\\U', 'AppData', 'Local', 'orch'));
  });

  it('uses Application Support on macOS', () => {
    const p = runtimePaths({}, 'darwin', '/Users/u');
    expect(p.config).toBe(join('/Users/u', 'Library', 'Application Support', 'orch'));
    expect(p.data).toBe(p.config);
  });

  it('uses XDG dirs on Linux', () => {
    expect(runtimePaths({}, 'linux', '/home/u').config).toBe(join('/home/u', '.config', 'orch'));
    expect(runtimePaths({ XDG_DATA_HOME: '/d' }, 'linux', '/home/u').data).toBe(join('/d', 'orch'));
  });
});

describe('install metadata', () => {
  it('reads package.json from the install root', () => {
    expect(packageInfo().name).toBe('orch');
    expect(installRoot()).toMatch(/[\\/]$/);
  });
});

describe('findProjectRoot', () => {
  it('finds this repository from a subdirectory', () => {
    expect(findProjectRoot(join(installRoot(), 'src'))).toBeDefined();
  });

  it('returns undefined outside a repository', () => {
    expect(findProjectRoot(tmpdir())).toBeUndefined();
  });
});
