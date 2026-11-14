/**
 * Which session is working in which checkout. One JSON file per checkout under
 * `<data>/checkouts/`, keyed by the checkout's canonical Git directory, holding a lease like a
 * job's: the owning session, when it lapses, and how long each renewal lasts. There is no daemon,
 * so a lease is renewed only when the owner claims again (the Edit/Write hook does that on every
 * write); a session that dies simply lets it lapse. Files, not the database: the guard runs from
 * whatever checkout a session is in, and must never migrate the shared database as a side effect.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { type ClaimKind, decideClaim, leaseUntil } from '../core/ownership.ts';
import type { RuntimePaths } from '../core/paths.ts';
import { now } from '../core/workflow.ts';
import type { CheckoutIdentity } from '../git/repo.ts';

export interface CheckoutClaim extends CheckoutIdentity {
  session: string;
  leaseMinutes: number;
  claimedAt: string;
  renewedAt: string;
  leaseExpiresAt: string;
}

function dir(paths: RuntimePaths): string {
  return join(paths.data, 'checkouts');
}

function fileFor(paths: RuntimePaths, key: string): string {
  return join(dir(paths), `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
}

function parse(file: string): CheckoutClaim | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CheckoutClaim;
  } catch {
    return undefined; // missing, or half-written by a crashed process: treated as unclaimed
  }
}

/** The recorded claim for a checkout, if any. Read-only. */
export function readClaim(paths: RuntimePaths, key: string): CheckoutClaim | undefined {
  return parse(fileFor(paths, key));
}

export function listClaims(paths: RuntimePaths): CheckoutClaim[] {
  if (!existsSync(dir(paths))) return [];
  return readdirSync(dir(paths))
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => parse(join(dir(paths), f)) ?? []);
}

export interface ClaimCheckoutOptions {
  leaseMinutes?: number | undefined;
  /** Take the checkout from a session whose lease is still live. */
  force?: boolean | undefined;
}

/**
 * Take, renew, or reclaim a checkout for `session`. Throws OwnershipError while another session's
 * lease is live (unless forced). A first claim is created exclusively (`wx`), so two sessions
 * racing for an unclaimed checkout cannot both win; a renewal or reclaim replaces the file
 * atomically.
 */
export function claimCheckout(
  paths: RuntimePaths,
  identity: CheckoutIdentity,
  session: string,
  opts: ClaimCheckoutOptions = {},
): { claim: CheckoutClaim; kind: ClaimKind; previous: string | null } {
  const file = fileFor(paths, identity.key);
  const ts = now();
  const minutes = opts.leaseMinutes ?? DEFAULT_CHECKOUT_LEASE_MINUTES;
  for (let attempt = 0; ; attempt++) {
    const current = parse(file);
    const kind = decideClaim(
      { ownerSession: current?.session ?? null, leaseExpiresAt: current?.leaseExpiresAt ?? null },
      session,
      ts,
      opts.force,
    );
    const claim: CheckoutClaim = {
      ...identity,
      session,
      leaseMinutes: minutes,
      claimedAt: kind === 'renew' && current ? current.claimedAt : ts,
      renewedAt: ts,
      leaseExpiresAt: leaseUntil(ts, minutes),
    };
    const body = JSON.stringify(claim, null, 2);
    mkdirSync(dir(paths), { recursive: true });
    if (attempt === 0 && !existsSync(file)) {
      try {
        writeFileSync(file, body, { flag: 'wx' });
      } catch (err) {
        // Lost the race for a fresh claim: read what the winner wrote and decide against it.
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
    } else {
      // Renewal, reclaim, or a file that exists but does not parse (a crashed writer): replace it.
      const tmp = `${file}.${String(process.pid)}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, file);
    }
    return { claim, kind, previous: current?.session ?? null };
  }
}

/** Release one checkout held by `session`; another session's claim is left alone. */
export function releaseCheckout(paths: RuntimePaths, key: string, session: string): boolean {
  const file = fileFor(paths, key);
  const current = parse(file);
  if (current?.session !== session) return false;
  rmSync(file, { force: true });
  return true;
}

/** Release every checkout `session` holds (session end). Returns the released roots. */
export function releaseAll(paths: RuntimePaths, session: string): string[] {
  return listClaims(paths)
    .filter((c) => c.session === session)
    .filter((c) => releaseCheckout(paths, c.key, session))
    .map((c) => c.root);
}

export const DEFAULT_CHECKOUT_LEASE_MINUTES = 30;
