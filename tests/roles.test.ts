import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/core/errors.ts';
import {
  DEFAULT_UI_PATTERNS,
  detectUi,
  drawModel,
  drawModels,
  type Model,
  MODELS,
  parseConfig,
  resolveRoles,
  ROLES,
} from '../src/core/roles.ts';

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

describe('model pools (ticket 0168)', () => {
  it('accepts a model or a pool per role and refuses bad pools (AC1)', () => {
    expect(parseConfig({ models: { builder: 'opus' } }).models).toEqual({ builder: 'opus' });
    expect(parseConfig({ models: { builder: ['opus', 'fable'] } }).models).toEqual({
      builder: ['opus', 'fable'],
    });
    for (const bad of [[], ['opus', 'opus'], ['opus', 1], ['opus', 'gpt'], 'gpt']) {
      expect(() => parseConfig({ models: { builder: bad } }), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
    expect(() => parseConfig({ models: { nobody: ['opus'] } })).toThrow(/unknown role "nobody"/);
  });

  it("knows fable; a string-only config is a one-element pool with today's model (AC2)", () => {
    expect(MODELS).toContain('fable');
    const config = parseConfig({ models: { security: 'sonnet' } });
    const roles = resolveRoles(config, 'job-00000001');
    expect(roles.find((r) => r.name === 'security')?.model).toBe('sonnet');
    for (const r of ROLES.filter((x) => x.name !== 'security')) {
      expect(roles.find((x) => x.name === r.name)?.model).toBe(r.model);
    }
  });

  it('draws deterministically and uniformly from the pool (AC3)', () => {
    expect(drawModel.length).toBe(3);
    const pool = ['opus', 'fable'] as const;
    expect(drawModel('job-0000abcd', 'builder', pool)).toBe(
      drawModel('job-0000abcd', 'builder', pool),
    );
    let opus = 0;
    for (let i = 0; i < 1000; i++) {
      const id = `job-${i.toString(16).padStart(8, '0')}`;
      if (drawModel(id, 'builder', pool) === 'opus') opus += 1;
      expect(drawModel(id, 'security', ['haiku'])).toBe('haiku');
    }
    expect(opus).toBeGreaterThanOrEqual(400);
    expect(opus).toBeLessThanOrEqual(600);
  });

  it('lists every role and flags same-as-author where a role has an author (AC4)', () => {
    const id = 'job-1234abcd';
    const drawn = drawModels(id, { builder: ['opus', 'fable'], security: ['opus', 'fable'] });
    expect(Object.keys(drawn)).toEqual(ROLES.map((r) => r.name));
    for (const r of ROLES) {
      const pool: Model[] =
        r.name === 'builder' || r.name === 'security' ? ['opus', 'fable'] : [r.model];
      expect(drawn[r.name]?.model).toBe(drawModel(id, r.name, pool));
    }
    const author = (role: string) => (role === 'spec-challenger' ? 'spec-writer' : 'builder');
    for (const r of ROLES) {
      if (['spec-writer', 'builder', 'fast-builder'].includes(r.name)) {
        expect(drawn[r.name]).not.toHaveProperty('sameAsAuthor');
      } else {
        expect(drawn[r.name]?.sameAsAuthor).toBe(
          drawn[r.name]?.model === drawn[author(r.name)]?.model,
        );
      }
    }
    // inherit against inherit counts as the same: orch only sees the strings.
    const inherit = drawModels(id, { builder: 'inherit', approver: 'inherit' });
    expect(inherit['approver']?.sameAsAuthor).toBe(true);
  });
});
