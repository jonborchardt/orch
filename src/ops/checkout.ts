/**
 * Cooperative checkout ownership: before a session writes into a checkout, find out whether
 * another live session is already working there. Identity comes from Git (`checkoutIdentity`),
 * the lease from `storage/checkouts.ts`. `hook` speaks Claude Code's hook protocol so the same
 * rule runs from a PreToolUse hook on Edit/Write. This detects accidental sharing of one checkout
 * between sessions; it is not filesystem isolation, and a process that writes without asking is
 * not stopped by it.
 */
import { OwnershipError, ValidationError } from '../core/errors.ts';
import type { RuntimePaths } from '../core/paths.ts';
import { now } from '../core/workflow.ts';
import { type CheckoutIdentity, checkoutIdentity } from '../git/repo.ts';
import { tryGit } from '../git/run.ts';
import {
  type CheckoutClaim,
  claimCheckout,
  type ClaimCheckoutOptions,
  claimExpiresAt,
  claimLive,
  listClaims,
  readClaim,
  releaseAll,
  releaseCheckout,
} from '../storage/checkouts.ts';

export interface CheckoutStatus {
  path: string;
  checkout: CheckoutIdentity | null;
  owner: LiveClaim | null;
}

/** A claim with its effective expiry: the lease, extended by the holder's last recorded activity. */
export type LiveClaim = CheckoutClaim & { live: boolean; expiresAt: string };

function withLiveness(claim: CheckoutClaim | undefined): LiveClaim | null {
  if (!claim) return null;
  return { ...claim, live: claimLive(claim, now()), expiresAt: claimExpiresAt(claim) };
}

/** Who holds the checkout containing `path`. Read-only; never claims. */
export function checkoutStatus(paths: RuntimePaths, path: string): CheckoutStatus {
  const checkout = checkoutIdentity(path) ?? null;
  return {
    path,
    checkout,
    owner: checkout ? withLiveness(readClaim(paths, checkout.key)) : null,
  };
}

/** Every recorded claim, with liveness, for `orch checkout list`. Read-only. */
export function listCheckouts(paths: RuntimePaths): LiveClaim[] {
  return listClaims(paths).flatMap((c) => withLiveness(c) ?? []);
}

export interface ClaimResult {
  checkout: CheckoutIdentity;
  claim: CheckoutClaim;
  kind: 'new' | 'renew' | 'reclaim';
  previous: string | null;
}

/** Claim the checkout containing `path` for `session`; exit 4 while another live session holds it. */
export function claimCheckoutAt(
  paths: RuntimePaths,
  path: string,
  session: string,
  opts: ClaimCheckoutOptions = {},
): ClaimResult {
  const checkout = checkoutIdentity(path);
  if (!checkout) throw new ValidationError(`${path} is not inside a Git repository.`);
  const r = claimCheckout(paths, checkout, session, opts);
  return { checkout, ...r };
}

export function releaseCheckoutAt(
  paths: RuntimePaths,
  path: string,
  session: string,
): { released: boolean; checkout: CheckoutIdentity } {
  const checkout = checkoutIdentity(path);
  if (!checkout) throw new ValidationError(`${path} is not inside a Git repository.`);
  return { released: releaseCheckout(paths, checkout.key, session), checkout };
}

export function releaseAllCheckouts(paths: RuntimePaths, session: string): { released: string[] } {
  return { released: releaseAll(paths, session) };
}

/** The fields of a Claude Code hook payload this guard reads. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string } | undefined;
}

export interface HookOutcome {
  /** 0 proceed; 2 block (PreToolUse only). Nothing else is ever returned. */
  exitCode: 0 | 2;
  /** Context for the session (SessionStart) or the hook's own report (--json). */
  stdout: string;
  /** The reason a write was refused; Claude Code shows it to the model. */
  stderr: string;
  action: 'claimed' | 'refused' | 'reported' | 'released' | 'ignored';
}

const IGNORED: HookOutcome = { exitCode: 0, stdout: '', stderr: '', action: 'ignored' };

export function parseHookInput(text: string): HookInput {
  if (text.trim() === '') return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ValidationError('Hook input is not JSON.');
  }
  if (typeof raw !== 'object' || raw === null)
    throw new ValidationError('Hook input is not an object.');
  return raw;
}

function describe(owner: LiveClaim): string {
  return `session ${owner.session} (${owner.kind} checkout ${owner.root}, live until ${owner.expiresAt})`;
}

/**
 * Claude Code hook: PreToolUse on Edit/Write claims the checkout that contains the file and
 * blocks (exit 2) while another live session holds it; SessionStart only reports an existing
 * holder as context, so a read-only session never claims anything; SessionEnd releases whatever
 * this session held. Any other event, a tool call without a file path, or a write to a file Git
 * ignores is ignored. The claim
 * records `transcript_path`, so the holder stays live while its session is active at all, not
 * only while it edits.
 */
export function hookCheckout(paths: RuntimePaths, input: HookInput): HookOutcome {
  const session = input.session_id;
  if (!session) return IGNORED;
  const event = input.hook_event_name;
  if (event === 'SessionEnd') {
    return releaseAll(paths, session).length ? { ...IGNORED, action: 'released' } : IGNORED;
  }
  if (event === 'SessionStart') {
    const s = input.cwd ? checkoutStatus(paths, input.cwd) : null;
    if (!s?.checkout || !s.owner || s.owner.session === session || !s.owner.live) {
      return IGNORED;
    }
    return {
      exitCode: 0,
      stdout:
        `orch checkout guard: ${s.checkout.root} is being edited by another live Claude session, ` +
        `${describe(s.owner)}. Edits here will be refused until that lease lapses or is released; ` +
        'work in your own worktree, or take it over deliberately with `orch checkout claim --force`.',
      stderr: '',
      action: 'reported',
    };
  }
  if (event !== 'PreToolUse') return IGNORED;
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) return IGNORED;
  const checkout = checkoutIdentity(file);
  if (!checkout) return IGNORED;
  // A file Git ignores is in no commit of this checkout, so two sessions may share it (decision
  // 2026-11-18-checkout-guard-skips-ignored-files).
  if (tryGit(checkout.root, 'check-ignore', '-q', file) !== undefined) {
    return IGNORED;
  }
  try {
    claimCheckout(paths, checkout, session, { transcript: input.transcript_path });
    return { exitCode: 0, stdout: '', stderr: '', action: 'claimed' };
  } catch (err) {
    if (!(err instanceof OwnershipError)) throw err;
    const owner = withLiveness(readClaim(paths, checkout.key));
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        `orch checkout guard refused the write: ${checkout.root} is held by ` +
        `${owner ? describe(owner) : 'another session'}. Two sessions editing one checkout corrupt ` +
        'each other’s test runs and commits. Use a worktree of your own, wait for the lease to ' +
        `lapse, or if that session is gone run: orch checkout claim --path "${checkout.root}" ` +
        `--session ${session} --force`,
      action: 'refused',
    };
  }
}
