/**
 * Checkout ownership: one session per checkout, detected before a write. Real repositories and
 * linked worktrees; the hook protocol is exercised both in-process and through the CLI with the
 * JSON Claude Code sends. Nothing here touches a real ORCH_HOME.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OwnershipError, ValidationError } from '../src/core/errors.ts';
import { installRoot } from '../src/core/paths.ts';
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
const pre = (session: string, file: string, transcript?: string) => ({
  hook_event_name: 'PreToolUse',
  session_id: session,
  cwd: repo,
  tool_name: 'Edit',
  tool_input: { file_path: file },
  ...(transcript ? { transcript_path: transcript } : {}),
});
const claimFile = (key: string) =>
  join(home, 'checkouts', `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
/** A fake Claude Code transcript last written `minutesAgo`. */
function transcriptFile(minutesAgo: number): string {
  const file = join(tempDir('orch-co-transcript-'), 'session.jsonl');
  dirs.push(join(file, '..'));
  writeFileSync(file, '{}\n');
  const t = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(file, t, t);
  return file;
}

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
    // A file Git ignores is in no commit: B may write it while A holds the checkout.
    writeFileSync(join(repo, '.gitignore'), '/todo/\n');
    expect(hookCheckout(paths(), pre('B', join(repo, 'todo', 'x.md'))).action).toBe('ignored');
    expect(hookCheckout(paths(), pre('B', join(repo, 'b.ts'))).exitCode).toBe(2);
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

describe('liveness while the holder is active but not editing', () => {
  it('a lapsed lease stays live while the holder\u2019s transcript is being written', () => {
    const identity = checkoutIdentity(repo);
    if (!identity) throw new Error('no identity');
    const active = transcriptFile(1);
    claimCheckout(paths(), identity, 'A', { leaseMinutes: 10, transcript: active });
    // Age the lease past expiry while the session keeps writing its transcript.
    const claim = readClaim(paths(), identity.key);
    if (!claim) throw new Error('no claim');
    writeFileSync(
      claimFile(identity.key),
      JSON.stringify({ ...claim, leaseExpiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    const owner = checkoutStatus(paths(), repo).owner;
    expect(owner).toMatchObject({ session: 'A', live: true });
    expect(owner?.expiresAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(() => claimCheckoutAt(paths(), repo, 'B')).toThrow(OwnershipError);
    const refused = hookCheckout(paths(), pre('B', join(repo, 'b.ts')));
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('live until');
    // The same transcript idle for longer than the lease: the holder is gone, B takes over.
    const idle = new Date(Date.now() - 11 * 60_000);
    utimesSync(active, idle, idle);
    expect(checkoutStatus(paths(), repo).owner?.live).toBe(false);
    expect(hookCheckout(paths(), pre('B', join(repo, 'b.ts'))).action).toBe('claimed');
    // A's next write is refused: it learns it was superseded instead of racing.
    expect(hookCheckout(paths(), pre('A', join(repo, 'a.ts'), active)).exitCode).toBe(2);
  });

  it('a claim without a transcript, or whose transcript is gone, lapses on the lease alone', () => {
    const identity = checkoutIdentity(repo);
    if (!identity) throw new Error('no identity');
    const gone = transcriptFile(0);
    claimCheckout(paths(), identity, 'A', { leaseMinutes: 0, transcript: gone });
    rmSync(gone);
    expect(checkoutStatus(paths(), repo).owner?.live).toBe(false);
    expect(claimCheckoutAt(paths(), repo, 'B').kind).toBe('reclaim');
    expect(readClaim(paths(), identity.key)?.transcript).toBeUndefined();
  });

  it('the hook records the transcript and a renewal keeps it', () => {
    const transcript = transcriptFile(0);
    hookCheckout(paths(), pre('A', join(repo, 'a.ts'), transcript));
    expect(checkoutStatus(paths(), repo).owner?.transcript).toBe(transcript);
    // A CLI renewal by the same session (no transcript in hand) does not drop it.
    expect(claimCheckoutAt(paths(), repo, 'A').claim.transcript).toBe(transcript);
    // A different session taking over by force does not inherit it.
    expect(claimCheckoutAt(paths(), repo, 'B', { force: true }).claim.transcript).toBeUndefined();
  });
});

describe('the shipped hook command (.claude/settings.json)', () => {
  const settings = JSON.parse(
    readFileSync(join(installRoot(), '.claude', 'settings.json'), 'utf8'),
  ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const commands = ['PreToolUse', 'SessionStart', 'SessionEnd'].map(
    (e) => settings.hooks[e]?.[0]?.hooks[0]?.command,
  );
  const command = commands[0] ?? '';
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  // Claude Code runs hooks on Windows with Git Bash (CLAUDE_CODE_GIT_BASH_PATH, else the one
  // installed with git), never whatever `bash` PATH finds first: that can be the WSL launcher,
  // which sees neither Windows paths nor this environment.
  const bash = (() => {
    if (process.platform !== 'win32') return 'bash';
    const configured = process.env['CLAUDE_CODE_GIT_BASH_PATH'];
    if (configured) return configured;
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    const exec = git.error ? '' : git.stdout.trim();
    const found = exec ? join(exec, '..', '..', '..', 'bin', 'bash.exe') : '';
    return found && existsSync(found) ? found : undefined;
  })();
  const noBash = !bash || spawnSync(bash, ['-c', 'exit 0']).status !== 0;
  const skipReason = 'no Git Bash found: Claude Code could not run the hook either';
  const run = (projectDir: string, bin: string | undefined, payload: unknown) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ORCH_HOME: home,
      CLAUDE_PROJECT_DIR: projectDir,
    };
    if (bin) env[pathKey] = `${bin}${delimiter}${process.env[pathKey] ?? ''}`;
    const r = spawnSync(bash ?? 'bash', ['-c', command], {
      cwd: projectDir,
      encoding: 'utf8',
      env,
      input: JSON.stringify(payload),
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  /** A directory holding a fake `orch` on PATH. */
  const fakeOrch = (script: string) => {
    const bin = tempDir('orch-co-bin-');
    dirs.push(bin);
    writeFileSync(join(bin, 'orch'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return bin;
  };

  it('is one command for all three events and runs the checkout source when present', (ctx) => {
    expect(new Set(commands).size).toBe(1);
    expect(command).toContain('src/cli/checkout.ts');
    if (noBash) return ctx.skip(skipReason);
    const r = run(installRoot(), undefined, pre('A', join(repo, 'a.ts')));
    expect(r.code, r.err).toBe(0);
    expect(checkoutStatus(paths(), repo).owner?.session).toBe('A');
    const refused = run(installRoot(), undefined, pre('B', join(repo, 'b.ts')));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('held by session A');
  });

  it('on a branch without the command it warns and continues instead of blocking or staying silent', (ctx) => {
    if (noBash) return ctx.skip(skipReason);
    const old = tempDir('orch-co-oldbranch-');
    dirs.push(old);
    expect(existsSync(join(old, 'src', 'cli', 'checkout.ts'))).toBe(false);
    // An installed orch from before the checkout command: "Unknown command", exit 2, which a
    // PreToolUse hook would otherwise read as a refusal of every write.
    const oldOrch = fakeOrch('echo "UsageError: Unknown command: checkout" >&2; exit 2');
    const r = run(old, oldOrch, pre('A', join(repo, 'a.ts')));
    expect(r.code).toBe(1);
    expect(r.err).toContain('INACTIVE');
    expect(listCheckouts(paths())).toEqual([]);
    // No orch at all: the same visible, non-blocking outcome.
    const none = run(old, fakeOrch('exit 127'), pre('A', join(repo, 'a.ts')));
    expect(none.code).toBe(1);
    expect(none.err).toContain('INACTIVE');
  });

  it('falls back to an installed orch that has the checkout command', (ctx) => {
    if (noBash) return ctx.skip(skipReason);
    const old = tempDir('orch-co-oldbranch-');
    dirs.push(old);
    const newOrch = fakeOrch(
      'case "$2" in list) exit 0;; hook) cat >/dev/null; echo "installed orch handled $1 $2"; exit 0;; esac; exit 2',
    );
    const r = run(old, newOrch, pre('A', join(repo, 'a.ts')));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('installed orch handled checkout hook');
  });

  /** A job worktree: this repository's source, but no node_modules to run it with. */
  const sourceWithoutDeps = () => {
    const dir = tempDir('orch-co-nodeps-');
    dirs.push(dir);
    mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
    writeFileSync(join(dir, 'src', 'cli', 'checkout.ts'), '');
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    return dir;
  };

  it('uses the installed orch when the checkout has source but no dependencies', (ctx) => {
    if (noBash) return ctx.skip(skipReason);
    const newOrch = fakeOrch(
      'case "$2" in list) exit 0;; hook) cat >/dev/null; echo "installed orch handled $1 $2"; exit 0;; esac; exit 2',
    );
    const r = run(sourceWithoutDeps(), newOrch, pre('A', join(repo, 'a.ts')));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('installed orch handled checkout hook');
    expect(r.err).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('warns INACTIVE when the checkout has no dependencies and no capable orch', (ctx) => {
    if (noBash) return ctx.skip(skipReason);
    const dir = sourceWithoutDeps();
    for (const script of ['exit 127', 'echo "UsageError: Unknown command: checkout" >&2; exit 2']) {
      const r = run(dir, fakeOrch(script), pre('A', join(repo, 'a.ts')));
      expect(r.code, r.err).toBe(1);
      expect(r.err).toContain('INACTIVE');
      expect(r.err).not.toContain('ERR_MODULE_NOT_FOUND');
    }
    expect(listCheckouts(paths())).toEqual([]);
  });
});
