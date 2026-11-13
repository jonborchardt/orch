import { describe, expect, it } from 'vitest';

import { OwnershipError } from '../src/core/errors.ts';
import {
  assertOwner,
  decideClaim,
  leaseExpired,
  leaseUntil,
  newToken,
} from '../src/core/ownership.ts';

const t0 = '2026-01-01T00:00:00.000Z';
const owned = (leaseExpiresAt: string | null) => ({
  ownerSession: 'a',
  ownerToken: 'tok',
  leaseExpiresAt,
  status: 'running' as const,
});
const free = {
  ownerSession: null,
  ownerToken: null,
  leaseExpiresAt: null,
  status: 'pending' as const,
};

describe('leases', () => {
  it('leaseUntil adds minutes in ISO time', () => {
    expect(leaseUntil(t0, 30)).toBe('2026-01-01T00:30:00.000Z');
  });

  it('leaseExpired compares ISO strings; a null lease counts as expired', () => {
    expect(leaseExpired(owned(leaseUntil(t0, 1)), t0)).toBe(false);
    expect(leaseExpired(owned(t0), leaseUntil(t0, 1))).toBe(true);
    expect(leaseExpired(owned(null), t0)).toBe(true);
  });
});

describe('decideClaim', () => {
  it('unowned -> new; same session -> renew', () => {
    expect(decideClaim(free, 'a', t0)).toBe('new');
    expect(decideClaim(owned(leaseUntil(t0, 5)), 'a', t0)).toBe('renew');
  });

  it('rejects a competing claim on a live lease unless forced', () => {
    const live = owned(leaseUntil(t0, 5));
    expect(() => decideClaim(live, 'b', t0)).toThrow(OwnershipError);
    expect(() => decideClaim(live, 'b', t0)).toThrow(/owned by session a/);
    expect(decideClaim(live, 'b', t0, true)).toBe('reclaim');
  });

  it('allows reclaiming an expired lease', () => {
    expect(decideClaim(owned(t0), 'b', leaseUntil(t0, 1))).toBe('reclaim');
  });
});

describe('assertOwner', () => {
  it('requires a claim, a token, and the matching token', () => {
    const check = (job: Parameters<typeof assertOwner>[0], token: string | undefined) => () => {
      assertOwner(job, token);
    };
    expect(check(free, 'x')).toThrow(/not claimed/);
    expect(check(owned(t0), undefined)).toThrow(/Missing --token/);
    expect(check(owned(t0), 'other')).toThrow(/Stale or invalid token/);
    expect(check(owned(t0), 'tok')).not.toThrow();
  });

  it('tokens are unpredictable and unique', () => {
    const a = newToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newToken());
  });
});
