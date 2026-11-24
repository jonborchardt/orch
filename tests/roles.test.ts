import { describe, expect, it } from 'vitest';

import { DEFAULT_UI_PATTERNS, detectUi } from '../src/core/roles.ts';

describe('detectUi', () => {
  const ui = (files: string[], patterns: readonly string[] = DEFAULT_UI_PATTERNS) =>
    detectUi(files, patterns);

  it('ignores test files, whatever pattern matches them', () => {
    for (const f of [
      'web/src/App.test.tsx',
      'web/src/api.test.tsx',
      'src/Header.spec.tsx',
      'e2e/dashboard.spec.ts',
      'web/src/__tests__/X.tsx',
      'tests/fixtures/page.html',
      'web\\src\\App.test.tsx',
    ]) {
      expect(ui([f]), f).toBe(false);
    }
    expect(ui(['src/a.test.ts'], ['\\.ts$'])).toBe(false);
  });

  it('still counts rendered UI, alone or mixed with tests', () => {
    for (const f of [
      'web/src/App.tsx',
      'src/header.css',
      'web/index.html',
      'public/logo.svg',
      'web\\src\\App.tsx',
    ]) {
      expect(ui([f]), f).toBe(true);
    }
    expect(ui(['web/src/App.test.tsx', 'web/src/App.tsx'])).toBe(true);
    expect(ui(['src/a.ts'], ['\\.ts$'])).toBe(true);
  });

  it('is false for non-UI changes', () => {
    expect(ui(['src/export.ts'])).toBe(false);
  });
});
