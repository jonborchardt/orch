/**
 * `verification.authority` in factory.json: parsing, fingerprints, policy diffs, the documented
 * ORCH opt-in, a change of authority needing a human's accept-policy, and `orch verify` running
 * only the policy's commands under `ci`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/core/errors.ts';
import { installRoot } from '../src/core/paths.ts';
import {
  canonicalPolicy,
  diffPolicy,
  formatPolicy,
  parsePolicy,
  parsePolicyText,
  policyFingerprint,
} from '../src/core/verification.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { pushBranch } from '../src/ops/github.ts';
import { claimJob, getJob } from '../src/storage/jobs.ts';
import {
  add,
  CI_POLICY,
  go,
  passRound,
  POLICY,
  SESSION,
  start,
  toReview,
  useCiAuthority,
  verify,
} from './drive.ts';
import { commitFile } from './helpers.ts';
import { clone, store } from './verify-fixture.ts';

const check = { id: 'check', command: 'node', args: ['check.js'] };
const local = (extra: Record<string, unknown> = {}) =>
  parsePolicy({ verification: { ...extra, commands: [check] } });

describe('parsing authority', () => {
  it('absent or "local" is the old policy, byte for byte', () => {
    const before =
      '[{"args":["check.js"],"command":"node","cwd":".","id":"check","required":true,"timeoutMs":600000}]';
    for (const p of [local(), local({ authority: 'local' })]) {
      expect(p).toEqual({ commands: [expect.objectContaining({ id: 'check' })] });
      expect(canonicalPolicy(p)).toBe(before);
      expect(policyFingerprint(p)).toBe(policyFingerprint(local()));
      expect(formatPolicy(p)).not.toContain('authority');
    }
  });

  it('"ci" parses, round-trips, and changes the fingerprint; other values fail', () => {
    const ci = local({ authority: 'ci' });
    expect(ci.authority).toBe('ci');
    expect(parsePolicyText(formatPolicy(ci))).toEqual(ci);
    expect(policyFingerprint(ci)).not.toBe(policyFingerprint(local()));
    for (const bad of ['both', 'CI', 1, null]) {
      expect(() => local({ authority: bad })).toThrow(ValidationError);
    }
    expect(() => local({ authority: 'both' })).toThrow(/verification.authority must be one of/);
  });

  it('a change of authority is a policy change; local -> ci weakens', () => {
    const ci = local({ authority: 'ci' });
    expect(diffPolicy(local(), ci)).toEqual({
      changed: true,
      added: [],
      removed: [],
      modified: [],
      weakened: ['authority'],
      authority: 'local -> ci',
    });
    expect(diffPolicy(ci, local())).toMatchObject({
      changed: true,
      weakened: [],
      authority: 'ci -> local',
    });
    expect(diffPolicy(local(), local())).toEqual({
      changed: false,
      added: [],
      removed: [],
      modified: [],
      weakened: [],
    });
  });

  it('verification.regression parses with defaults; bad shapes and unknown keys fail', () => {
    const r = local({ regression: { command: 'npx', args: ['vitest', 'run'] } });
    expect(r.regression).toEqual({
      command: 'npx',
      args: ['vitest', 'run'],
      cwd: '.',
      timeoutMs: 600_000,
    });
    expect(local({ regression: { command: 'node', cwd: './web' } }).regression).toMatchObject({
      args: [],
      cwd: 'web',
    });
    const bad: unknown[] = [
      { command: 'node', id: 'x' },
      { command: 'node', required: true },
      { command: 'node', shell: true },
      { command: 1 },
      { command: './bin/test' },
      { command: 'npm run test' },
      { command: 'node', args: '--test' },
      { command: 'node', cwd: '/abs' },
      { command: 'node', cwd: 'C:/x' },
      { command: 'node', cwd: 'a/../..' },
      { command: 'node', timeoutMs: 10 },
      { command: 'node', timeoutMs: 1.5 },
      { command: 'node', timeoutMs: 4 * 60 * 60_000 },
      'node --test',
      [],
      null,
    ];
    for (const regression of bad) {
      expect(() => local({ regression }), JSON.stringify(regression)).toThrow(ValidationError);
    }
    expect(() => local({ regression: { command: 'node', shell: true } })).toThrow(
      /verification.regression: unknown key "shell"/,
    );
    expect(() => local({ regressions: {} })).toThrow(/verification: unknown key "regressions"/);
  });

  it('regression joins the fingerprint only when set, and changing it is a policy change', () => {
    const before =
      '[{"args":["check.js"],"command":"node","cwd":".","id":"check","required":true,"timeoutMs":600000}]';
    expect(canonicalPolicy(local())).toBe(before);
    const r = local({ regression: { command: 'node', args: ['--test'] } });
    expect(policyFingerprint(r)).not.toBe(policyFingerprint(local()));
    const ci = local({ authority: 'ci' });
    const ciR = local({ authority: 'ci', regression: { command: 'node', args: ['--test'] } });
    expect(policyFingerprint(ciR)).not.toBe(policyFingerprint(ci));
    expect(policyFingerprint(ciR)).not.toBe(policyFingerprint(r));
    expect(diffPolicy(local(), r)).toMatchObject({ changed: true, weakened: [] });
    expect(diffPolicy(r, r).changed).toBe(false);
  });

  it('the decision records the ORCH opt-in as a factory.json that parses', () => {
    const file = join(
      installRoot(),
      'docs',
      'decisions',
      '2026-11-22-ci-authoritative-verification.md',
    );
    const text = readFileSync(file, 'utf8');
    const pending = text.slice(text.indexOf('## Pending: ORCH opt-in'));
    const json = /```json\r?\n([\s\S]*?)```/.exec(pending)?.[1] ?? '';
    const policy = parsePolicyText(json);
    expect(policy.authority).toBe('ci');
    expect(policy.commands.map((c) => [c.command, ...c.args])).toEqual([
      ['npm', 'run', 'typecheck'],
      ['npm', 'run', 'lint'],
      ['npm', 'run', 'format:check'],
      ['npm', 'run', 'build'],
    ]);
  });
});

describe('changing authority needs a human', () => {
  it('local -> ci refuses approval, naming the change, until accept-policy; then ci applies', () => {
    const c = start(store, clone);
    toReview(store, c);
    passRound(store, c);
    go(store, c, 'start');
    commitFile(c.wt, 'factory.json', JSON.stringify(CI_POLICY, null, 2) + '\n');
    verify(store, c);
    add(store, c, 'decision.md');
    expect(() => go(store, c, 'complete')).toThrow(/authority: local -> ci.*accept-policy/);
    go(store, c, 'escalate', 'verification policy needs human acceptance');
    dashboardAction(store, c.id, { action: 'accept-policy' });
    expect(getJob(store.db, c.id).policy?.authority).toBe('ci');
    expect(getJob(store.db, c.id).stage).toBe('approve');
    const c2 = { ...c, token: claimJob(store, c.id, { session: SESSION }).token };
    go(store, c2, 'start');
    verify(store, c2);
    // The accepted authority applies: approval now needs CI to have passed for HEAD.
    expect(() => go(store, c2, 'complete')).toThrow(/GitHub CI the test gate/);
  });

  it('ci -> local refuses the pre-review push until accept-policy; then approval is needed', () => {
    useCiAuthority(clone);
    const c = start(store, clone);
    toReview(store, c);
    expect(getJob(store.db, c.id).stage).toBe('pr');
    go(store, c, 'start');
    commitFile(c.wt, 'factory.json', JSON.stringify(POLICY, null, 2) + '\n');
    verify(store, c);
    expect(() => pushBranch(store, c.id, { token: c.token })).toThrow(/authority: ci -> local/);
    go(store, c, 'escalate', 'verification policy needs human acceptance');
    dashboardAction(store, c.id, { action: 'accept-policy' });
    expect(getJob(store.db, c.id).stage).toBe('pr');
    const c2 = { ...c, token: claimJob(store, c.id, { session: SESSION }).token };
    go(store, c2, 'start');
    verify(store, c2);
    expect(() => pushBranch(store, c.id, { token: c2.token })).toThrow(/No DECISION: APPROVE/);
  });
});

describe('orch verify under ci', () => {
  it('runs exactly the policy commands', () => {
    useCiAuthority(clone);
    const c = start(store, clone);
    go(store, c, 'start');
    add(store, c, 'spec.md');
    add(store, c, 'spec-review-1.md');
    go(store, c, 'complete');
    go(store, c, 'start');
    commitFile(c.wt, 'src/export.ts', '// export\n');
    const r = verify(store, c);
    expect(r.status).toBe('passed');
    expect(r.policy.authority).toBe('ci');
    expect(r.checks.map((x) => x.checkId)).toEqual(['check']);
  });
});
