/**
 * The readiness grade: the pure rule with explicit facts, and GitHub's facts read through the
 * stateful gh shim (no network).
 */
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { gradeReadiness, type ReadinessFacts, runsTests } from '../src/core/readiness.ts';
import { branchRuleFacts } from '../src/integrations/github.ts';
import { type GhShim, ghShim } from './helpers.ts';

const facts = (
  policyTest: boolean | null,
  requiredChecks: boolean | null,
  upToDate: boolean | null,
  protection: boolean | null,
): ReadinessFacts => ({ policyTest, requiredChecks, upToDate, protection });

describe('gradeReadiness', () => {
  it('grades by the number of true facts: A=4, B=3, C=2, D=1 or 0', () => {
    expect(gradeReadiness(facts(true, true, true, true))).toMatchObject({
      letter: 'A',
      met: 4,
      advice: [],
    });
    expect(gradeReadiness(facts(true, true, false, true))).toMatchObject({ letter: 'B', met: 3 });
    expect(gradeReadiness(facts(true, false, false, true))).toMatchObject({ letter: 'C', met: 2 });
    expect(gradeReadiness(facts(true, false, false, false))).toMatchObject({ letter: 'D', met: 1 });
    expect(gradeReadiness(facts(false, false, false, false))).toMatchObject({
      letter: 'D',
      met: 0,
    });
  });

  it('never counts an unknown fact as met, names it, and gives one advice line per unmet fact', () => {
    const g = gradeReadiness(facts(true, null, false, null));
    expect(g).toMatchObject({ letter: 'D', met: 1 });
    expect(g.advice).toHaveLength(3);
    expect(g.advice[0]).toMatch(/status check.*unknown/);
    expect(g.advice[1]).toMatch(/up to date.*merge queue/);
    expect(g.advice[1]).not.toMatch(/unknown/);
    expect(g.advice[2]).toMatch(/Protect the base branch.*unknown/);
    // The policy advice names the rule it applies.
    expect(gradeReadiness(facts(false, true, true, true)).advice).toEqual([
      expect.stringMatching(/"test" or "check"/),
    ]);
  });

  it('treats a check whose id or arguments contain test or check as running tests', () => {
    expect(runsTests({ id: 'check', args: [] })).toBe(true);
    expect(runsTests({ id: 'ci', args: ['run', 'test:unit'] })).toBe(true);
    expect(runsTests({ id: 'build', args: ['run', 'build'] })).toBe(false);
  });
});

describe('branchRuleFacts through the gh shim', () => {
  let shim: GhShim;
  beforeAll(() => {
    shim = ghShim('acme/alpha');
    Object.assign(process.env, shim.env);
  });
  afterAll(() => {
    for (const k of Object.keys(shim.env)) Reflect.deleteProperty(process.env, k);
    shim.cleanup();
  });
  beforeEach(() => {
    shim.reset();
  });
  const read = () => branchRuleFacts('acme/alpha', 'main', tmpdir());

  it('reads classic protection with strict and a protected branch as all three true', () => {
    shim.write({
      protection: { strict: true, contexts: ['ci'] },
      api: { 'repos/acme/alpha/branches/main': { name: 'main', protected: true } },
    });
    expect(read()).toEqual({ requiredChecks: true, upToDate: true, protection: true });
  });

  it('counts a merge_queue ruleset alone as up to date (and the ruleset as protection)', () => {
    shim.write({ rules: [{ type: 'merge_queue', parameters: {} }] });
    expect(read()).toEqual({ requiredChecks: false, upToDate: true, protection: true });
  });

  it('reads a ruleset with required checks and the strict policy', () => {
    shim.write({
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [{ context: 'ci' }],
            strict_required_status_checks_policy: true,
          },
        },
      ],
    });
    expect(read()).toEqual({ requiredChecks: true, upToDate: true, protection: true });
  });

  it('answers false for a 404 everywhere without throwing', () => {
    expect(read()).toEqual({ requiredChecks: false, upToDate: false, protection: false });
  });

  it('answers null for every fact when gh fails, and when gh is missing', () => {
    shim.write({ fail: 'api ' });
    expect(read()).toEqual({ requiredChecks: null, upToDate: null, protection: null });
    const saved = process.env['ORCH_GH_SHIM'];
    const path = process.env['PATH'];
    try {
      delete process.env['ORCH_GH_SHIM'];
      process.env['PATH'] = '';
      expect(read()).toEqual({ requiredChecks: null, upToDate: null, protection: null });
    } finally {
      process.env['ORCH_GH_SHIM'] = saved;
      process.env['PATH'] = path;
    }
  });
});
