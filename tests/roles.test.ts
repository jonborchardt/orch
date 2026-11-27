import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/core/errors.ts';
import {
  DEFAULT_UI_PATTERNS,
  detectUi,
  drawModel,
  type DrawnModels,
  drawModels,
  exhaustedModels,
  fallbackModel,
  fallbacksOf,
  judgeAt,
  type Model,
  modelAt,
  MODELS,
  parseConfig,
  planFallbacks,
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

describe('per-model limit fallback (ticket 0179)', () => {
  const ex = (...m: Model[]) => new Set<Model>(m);

  it('picks the next pool model that is not exhausted, wrapping; null when there is none', () => {
    expect(fallbackModel(['fable', 'opus'], 'fable', ex('fable'))).toBe('opus');
    expect(fallbackModel(['opus', 'sonnet', 'fable'], 'fable', ex('fable'))).toBe('opus');
    expect(fallbackModel(['fable', 'opus', 'sonnet'], 'fable', ex('fable', 'opus'))).toBe('sonnet');
    expect(fallbackModel(['fable', 'opus'], 'fable', ex('fable', 'opus'))).toBeNull();
    expect(fallbackModel(['fable'], 'fable', ex('fable'))).toBeNull();
    expect(fallbackModel(['fable', 'opus'], 'opus', ex('fable'))).toBe('opus');
    expect(fallbackModel(['fable', 'opus'], 'fable', ex())).toBe('fable');
  });

  it('exhausted: a future until, never a past one or another model; plus the session set', () => {
    const now = '2026-11-26T12:00:00.000Z';
    const records = [
      { model: 'fable', until: '2026-11-26T11:00:00.000Z' },
      { model: 'fable', until: null },
      { model: 'opus', until: '2026-11-27T00:00:00.000Z' },
    ];
    expect([...exhaustedModels(records, now)]).toEqual([]);
    expect([
      ...exhaustedModels([...records, { model: 'fable', until: '2026-11-26T13:00:00.000Z' }], now),
    ]).toEqual(['fable']);
    expect([...exhaustedModels(records, now, ['fable'])]).toEqual(['fable']);
  });

  const drawn: DrawnModels = {
    'spec-writer': { model: 'fable' },
    builder: { model: 'fable' },
    security: { model: 'opus', sameAsAuthor: false },
  };
  const fb = (role: string, from: Model, to: Model, at: string) => ({ role, from, to, at });
  const fallbacks = [fb('builder', 'fable', 'opus', 't2'), fb('builder', 'opus', 'sonnet', 't4')];

  it('modelAt: the draw before a fallback, then the latest fallback at that time', () => {
    expect(modelAt(drawn, fallbacks, 'builder', 't1')).toBe('fable');
    expect(modelAt(drawn, fallbacks, 'builder', 't3')).toBe('opus');
    expect(modelAt(drawn, fallbacks, 'builder', 't5')).toBe('sonnet');
    expect(modelAt(drawn, fallbacks, 'builder')).toBe('sonnet');
    expect(modelAt(drawn, fallbacks, 'spec-writer')).toBe('fable');
    expect(modelAt(null, [], 'builder')).toBeNull();
  });

  it('judgeAt compares with the author model of that time once a job fell back', () => {
    expect(judgeAt(drawn, [], 'security')).toEqual({ model: 'opus', sameAsAuthor: false });
    expect(judgeAt(drawn, fallbacks, 'security', 't3')).toEqual({
      model: 'opus',
      sameAsAuthor: true,
    });
    expect(judgeAt(drawn, fallbacks, 'security')).toEqual({ model: 'opus', sameAsAuthor: false });
  });

  it('fallbacksOf reads models.fallback events oldest first', () => {
    const e = (id: number, type: string, payload: Record<string, unknown>) => ({
      id,
      type,
      payload,
      createdAt: `t${String(id)}`,
    });
    expect(
      fallbacksOf([
        e(4, 'models.fallback', { role: 'builder', from: 'opus', to: 'sonnet' }),
        e(3, 'models.limit', { model: 'opus' }),
        e(2, 'models.fallback', { role: 'builder', from: 'fable', to: 'opus' }),
      ]),
    ).toEqual(fallbacks);
  });

  it('resolveRoles applies fallbacks after the draw, the latest per role winning', () => {
    const roles = resolveRoles(parseConfig({}), 'job-00000001', drawn, fallbacks);
    const of = (name: string) => roles.find((r) => r.name === name)?.model;
    expect(of('builder')).toBe('sonnet');
    expect(of('spec-writer')).toBe('fable');
    expect(of('security')).toBe('opus');
  });

  it('planFallbacks is all or nothing over the roles', () => {
    const roles = resolveRoles(parseConfig({}), 'job-00000001', {
      ...drawn,
      approver: { model: 'fable' },
    }).filter((r) => r.kind !== 'fast-build');
    const pools: Record<string, Model[]> = {
      builder: ['fable', 'opus'],
      'spec-writer': ['opus', 'fable'],
    };
    expect(planFallbacks(roles, { ...pools, approver: ['fable', 'sonnet'] }, ex('fable'))).toEqual([
      { role: 'spec-writer', from: 'fable', to: 'opus' },
      { role: 'builder', from: 'fable', to: 'opus' },
      { role: 'approver', from: 'fable', to: 'sonnet' },
    ]);
    expect(planFallbacks(roles, { ...pools, approver: ['fable'] }, ex('fable'))).toBeNull();
    expect(planFallbacks(roles, pools, ex())).toEqual([]);
  });
});
