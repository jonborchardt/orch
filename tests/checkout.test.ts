/**
 * Checkout ownership: one session per checkout, detected before a write. Real repositories and
 * linked worktrees; the hook protocol is exercised both in-process and through the CLI with the
 * JSON Claude Code sends. Nothing here touches a real ORCH_HOME.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { checkoutIdentity } from '../src/git/repo.ts';
import {
  checkoutStatus,
  claimCheckoutAt,
  hookCheckout,
  listCheckouts,
  parseHookInput,
  releaseAllCheckouts,
  releaseCheckoutAt,
} from '../src/ops/checkout.ts';
import { claimCheckout, readClaim } from '../src/storage/checkouts.ts';
import { gitIn, homePaths, json, makeRepo, orch, removeLink, tempDir } from './helpers.ts';

const WIN = process.platform === 'win32';
let home: string;
let repo: string;
let wt: string;
const dirs: string[] = [];

beforeEach(() => {
  home = tempDir('orch-co-home-');
  repo = makeRepo();
  wt = join(tempDir('orch-co-wt-'), 'linked');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
  dirs.push(home, repo, join(wt, '..'));
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const paths = () => homePaths(home);
const pre = (session: string, file: string) => ({
  hook_event_name: 'PreToolUse',
  session_id: session,
  cwd: repo,
  tool_name: 'Edit',
  tool_input: { file_path: file },
});

describe('checkout identity', () => {
  it('distinguishes the primary checkout from each linked worktree of the same repository', () => {
    const primary = checkoutIdentity(join(repo, 'README.md'));
    const linked = checkoutIdentity(wt);
    expect(primary).toMatchObject({ kind: 'primary', root: realpathSync.native(repo) });
    expect(linked).toMatchObject({ kind: 'worktree' });
    expect(primary?.commonDir).toBe(linked?.commonDir);
    expect(primary?.key).not.toBe(linked?.key);
    expect(primary?.key).toBe(primary?.commonDir);
    // A file that does not exist yet belongs to the checkout it will be written into.
    expect(checkoutIdentity(join(wt, 'src', 'new', 'file.ts'))?.key).toBe(linked?.key);
    expect(checkoutIdentity(tempDir('orch-co-plain-'))).toBeUndefined();
  });

  it('never conflates two unrelated repositories with the same directory name', () => {
    const sameName = (prefix: string) => {
      const dir = join(tempDir(prefix), 'proj');
      mkdirSync(dir);
      return makeRepo(undefined, dir);
    };
    const a = sameName('orch-co-a-');
    const b = sameName('orch-co-b-');
    dirs.push(join(a, '..'), join(b, '..'));
    expect(basename(a)).toBe(basename(b));
    expect(checkoutIdentity(a)?.key).not.toBe(checkoutIdentity(b)?.key);
  });

  it('treats a junction or symlink alias as the same checkout', () => {
    const alias = join(tempDir('orch-co-alias-'), 'repo');
    dirs.push(join(alias, '..'));
    try {
      symlinkSync(repo, alias, 'junction');
    } catch {
      return; // no link support here
    }
    try {
      expect(checkoutIdentity(alias)?.key).toBe(checkoutIdentity(repo)?.key);
    } finally {
      removeLink(alias);
    }
  });

  it.runIf(WIN)('Windows: drive letter and path capitalization do not change the identity', () => {
    const real = realpathSync.native(repo);
    const upper = real.charAt(0).toUpperCase() + real.slice(1);
    const lower = real.charAt(0).toLowerCase() + real.slice(1).toUpperCase();
    expect(checkoutIdentity(upper)?.key).toBe(checkoutIdentity(lower)?.key);
  });
});

describe('claims', () => {
  it('a single session takes an unowned checkout, renews it, and releases it', () => {
    expect(checkoutStatus(paths(), repo).owner).toBeNull();
    const first = claimCheckoutAt(paths(), repo, 's1');
    expect(first.kind).toBe('new');
    expect(first.previous).toBeNull();
    const again = claimCheckoutAt(paths(), join(repo, 'README.md'), 's1');
    expect(again.kind).toBe('renew');
    expect(again.claim.claimedAt).toBe(first.claim.claimedAt);
    expect(again.claim.leaseExpiresAt >= first.claim.leaseExpiresAt).toBe(true);
    expect(checkoutStatus(paths(), repo).owner).toMatchObject({ session: 's1', live: true });
    expect(releaseCheckoutAt(paths(), repo, 's1').released).toBe(true);
    expect(checkoutStatus(paths(), repo).owner).toBeNull();
    expect(() => claimCheckoutAt(paths(), tempDir('orch-co-none-'), 's1')).toThrow(ValidationError);
  });

  it('two sessions cannot hold one checkout; a live owner is never displaced without --force', () => {
    claimCheckoutAt(paths(), repo, 's1');
    expect(() => claimCheckoutAt(paths(), repo, 's2')).toThrow(OwnershipError);
    expect(() => claimCheckoutAt(paths(), join(repo, 'README.md'), 's2')).toThrow(/owned by/);
    expect(checkoutStatus(paths(), repo).owner?.session).toBe('s1');
    // Another session cannot release it either.
    expect(releaseCheckoutAt(paths(), repo, 's2').released).toBe(false);
    expect(checkoutStatus(paths(), repo).owner?.session).toBe('s1');
    const taken = claimCheckoutAt(paths(), repo, 's2', { force: true });
    expect(taken).toMatchObject({ kind: 'reclaim', previous: 's1' });
    expect(checkoutStatus(paths(), repo).owner?.session).toBe('s2');
  });

  it('two sessions work in different worktrees of one repository without conflict', () => {
    expect(claimCheckoutAt(paths(), repo, 's1').kind).toBe('new');
    expect(claimCheckoutAt(paths(), wt, 's2').kind).toBe('new');
    expect(() => claimCheckoutAt(paths(), join(wt, 'x.ts'), 's1')).toThrow(OwnershipError);
    expect(
      listCheckouts(paths())
        .map((c) => c.session)
        .sort(),
    ).toEqual(['s1', 's2']);
  });

  it('a stale lease is reclaimed; an interrupted session needs no ceremony to recover from', () => {
    const identity = checkoutIdentity(repo);
    if (!identity) throw new Error('no identity');
    claimCheckout(paths(), identity, 'dead', { leaseMinutes: 0 });
    expect(checkoutStatus(paths(), repo).owner).toMatchObject({ session: 'dead', live: false });
    const r = claimCheckoutAt(paths(), repo, 'fresh');
    expect(r).toMatchObject({ kind: 'reclaim', previous: 'dead' });
    // The old session's next claim is refused: it learns it was superseded instead of racing.
    expect(() => claimCheckoutAt(paths(), repo, 'dead')).toThrow(OwnershipError);
  });

  it('status and list are read-only and alias spellings resolve to the one claim', () => {
    claimCheckoutAt(paths(), repo, 's1');
    const before = JSON.stringify(readClaim(paths(), checkoutIdentity(repo)?.key ?? ''));
    checkoutStatus(paths(), join(repo, 'README.md'));
    listCheckouts(paths());
    expect(JSON.stringify(readClaim(paths(), checkoutIdentity(repo)?.key ?? ''))).toBe(before);
    if (WIN) {
      const real = realpathSync.native(repo);
      const flipped = real.charAt(0).toLowerCase() + real.slice(1).toUpperCase();
      expect(checkoutStatus(paths(), flipped).owner?.session).toBe('s1');
    }
  });

  it('a half-written claim file counts as unclaimed', () => {
    const identity = checkoutIdentity(repo);
    if (!identity) throw new Error('no identity');
    mkdirSync(join(home, 'checkouts'), { recursive: true });
    claimCheckout(paths(), identity, 's1');
    const files = listCheckouts(paths());
    expect(files).toHaveLength(1);
    // Corrupt the file the way a crash mid-write would.
    const file = join(
      home,
      'checkouts',
      `${createHash('sha256').update(identity.key).digest('hex').slice(0, 32)}.json`,
    );
    writeFileSync(file, '{"session": "s1", "leaseExp');
    expect(checkoutStatus(paths(), repo).owner).toBeNull();
    expect(claimCheckoutAt(paths(), repo, 's2').kind).toBe('new');
  });
});

describe('the Claude Code hook', () => {
  it('claims on the first write, blocks another session with exit 2, and never claims on reads', () => {
    const file = join(repo, 'src', 'a.ts');
    expect(hookCheckout(paths(), pre('A', file))).toMatchObject({ exitCode: 0, action: 'claimed' });
    const refused = hookCheckout(paths(), pre('B', join(repo, 'b.ts')));
    expect(refused.exitCode).toBe(2);
    expect(refused.action).toBe('refused');
    expect(refused.stderr).toContain('held by session A');
    expect(refused.stderr).toContain('--force');
    // A's own writes keep going (and renew the lease).
    expect(hookCheckout(paths(), pre('A', join(repo, 'c.ts'))).exitCode).toBe(0);
    // B may work in the linked worktree: a different checkout.
    expect(hookCheckout(paths(), pre('B', join(wt, 'b.ts')))).toMatchObject({ action: 'claimed' });
    // Tool calls without a file, files outside any repository, and unknown events are ignored.
    expect(hookCheckout(paths(), { ...pre('B', file), tool_input: undefined }).action).toBe(
      'ignored',
    );
    expect(hookCheckout(paths(), pre('B', join(tempDir('orch-co-out-'), 'x'))).action).toBe(
      'ignored',
    );
    expect(hookCheckout(paths(), { hook_event_name: 'PostToolUse', session_id: 'B' }).action).toBe(
      'ignored',
    );
    expect(hookCheckout(paths(), {}).action).toBe('ignored');
    expect(checkoutStatus(paths(), repo).owner?.session).toBe('A');
  });

  it('SessionStart reports a live holder as context without claiming; SessionEnd releases', () => {
    const start = (session: string, cwd: string) =>
      hookCheckout(paths(), { hook_event_name: 'SessionStart', session_id: session, cwd });
    expect(start('A', repo)).toMatchObject({ exitCode: 0, action: 'ignored', stdout: '' });
    expect(checkoutStatus(paths(), repo).owner).toBeNull(); // nothing was claimed by starting
    hookCheckout(paths(), pre('A', join(repo, 'a.ts')));
    hookCheckout(paths(), pre('A', join(wt, 'a.ts')));
    const warned = start('B', repo);
    expect(warned).toMatchObject({ exitCode: 0, action: 'reported' });
    expect(warned.stdout).toContain('another live Claude session');
    expect(warned.stdout).toContain('session A');
    expect(start('A', repo).action).toBe('ignored'); // the holder itself is not warned
    const end = hookCheckout(paths(), { hook_event_name: 'SessionEnd', session_id: 'A' });
    expect(end).toMatchObject({ exitCode: 0, action: 'released' });
    expect(listCheckouts(paths())).toEqual([]);
    expect(releaseAllCheckouts(paths(), 'A').released).toEqual([]);
  });

  it('a session that died without SessionEnd is recovered through lease expiry', () => {
    const identity = checkoutIdentity(repo);
    if (!identity) throw new Error('no identity');
    claimCheckout(paths(), identity, 'crashed', { leaseMinutes: 0 });
    // Its lapsed lease blocks nobody and triggers no warning.
    expect(
      hookCheckout(paths(), { hook_event_name: 'SessionStart', session_id: 'B', cwd: repo }).action,
    ).toBe('ignored');
    expect(hookCheckout(paths(), pre('B', join(repo, 'x.ts')))).toMatchObject({
      exitCode: 0,
      action: 'claimed',
    });
    expect(checkoutStatus(paths(), repo).owner).toMatchObject({ session: 'B', live: true });
  });

  it('rejects malformed hook input and tolerates an empty body', () => {
    expect(parseHookInput('')).toEqual({});
    expect(() => parseHookInput('not json')).toThrow(ValidationError);
    expect(() => parseHookInput('[1]')).not.toThrow();
    expect(() => parseHookInput('null')).toThrow(ValidationError);
  });

  it('runs through the CLI exactly as Claude Code invokes it, from any directory', () => {
    const elsewhere = tempDir('orch-co-cwd-');
    dirs.push(elsewhere);
    const hook = (payload: unknown) =>
      orch(home, elsewhere, ['checkout', 'hook'], {}, JSON.stringify(payload));
    const a = hook(pre('A', join(repo, 'a.ts')));
    expect(a.code, a.err).toBe(0);
    expect(a.out).toBe('');
    const b = hook(pre('B', join(repo, 'b.ts')));
    expect(b.code).toBe(2);
    expect(b.err).toContain('held by session A');
    expect(b.out).toBe('');
    const start = hook({ hook_event_name: 'SessionStart', session_id: 'B', cwd: repo });
    expect(start.code).toBe(0);
    expect(start.out).toContain('another live Claude session');
    expect(hook({ hook_event_name: 'SessionEnd', session_id: 'A' }).code).toBe(0);
    expect(json<unknown[]>(orch(home, elsewhere, ['--json', 'checkout', 'list']))).toEqual([]);
    // --json reports the hook outcome as data for diagnostics; the exit code is unchanged.
    const asJson = orch(
      home,
      elsewhere,
      ['--json', 'checkout', 'hook'],
      {},
      JSON.stringify(pre('A', join(repo, 'a.ts'))),
    );
    expect(json<{ action: string }>(asJson).action).toBe('claimed');
    expect(orch(home, elsewhere, ['checkout', 'hook'], {}, 'nope').code).toBe(1);
  });

  it('CLI: status, claim, release, and the exit codes a session can branch on', () => {
    const cwd = tempDir('orch-co-cli-');
    dirs.push(cwd);
    expect(orch(home, cwd, ['checkout']).code).toBe(2);
    expect(orch(home, cwd, ['checkout', 'bogus']).code).toBe(2);
    expect(orch(home, cwd, ['checkout', 'claim', '--path', repo]).code).toBe(2); // no session
    const first = json<{ kind: string; checkout: { kind: string } }>(
      orch(home, cwd, ['--json', 'checkout', 'claim', '--path', repo, '--session', 's1']),
    );
    expect(first).toMatchObject({ kind: 'new', checkout: { kind: 'primary' } });
    const refused = orch(home, cwd, ['checkout', 'claim', '--path', repo, '--session', 's2']);
    expect(refused.code).toBe(4);
    expect(refused.err).toMatch(/OwnershipError/);
    expect(
      json<{ kind: string }>(
        orch(home, cwd, ['--json', 'checkout', 'claim', '--path', wt], { ORCH_SESSION: 's2' }),
      ).kind,
    ).toBe('new');
    const status = json<{ owner: { session: string; live: boolean } }>(
      orch(home, cwd, ['--json', 'checkout', 'status', '--path', join(repo, 'README.md')]),
    );
    expect(status.owner).toMatchObject({ session: 's1', live: true });
    expect(orch(home, repo, ['checkout', 'status']).out).toContain('session         s1');
    expect(
      json<{ released: string[] }>(
        orch(home, cwd, ['--json', 'checkout', 'release', '--all', '--session', 's1']),
      ).released,
    ).toHaveLength(1);
    expect(json<unknown[]>(orch(home, cwd, ['--json', 'checkout', 'list']))).toHaveLength(1);
    expect(orch(home, cwd, ['checkout', 'claim', '--path', repo, '--session', 's2']).code).toBe(0);
  });
});
