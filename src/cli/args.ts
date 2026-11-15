/** Option parsing shared by the command handlers. Every failure is a UsageError (exit 2). */
import { UsageError } from '../core/errors.ts';
import type { Auth } from '../storage/jobs.ts';

export function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new UsageError(`${flag} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** An integer option no smaller than `min` (`--lease 30`, `--revision 7`, `--max-rounds 1`). */
export function int(value: string | undefined, flag: string, min = 0): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`${flag} must be an integer of at least ${String(min)}`);
  }
  return n;
}

export function need<T>(value: T | undefined, flag: string, help?: string): T {
  if (value === undefined || value === '') {
    throw new UsageError(`Missing required ${flag}${help ? `\n\n${help}` : ''}`);
  }
  return value;
}

/** `--token` (or $ORCH_TOKEN) plus the optional `--revision` guard, as storage expects them. */
export function authFrom(
  o: { token?: string | undefined; revision?: string | undefined },
  env: NodeJS.ProcessEnv,
): Auth {
  return { token: o.token ?? env['ORCH_TOKEN'], expectRevision: int(o.revision, '--revision') };
}
