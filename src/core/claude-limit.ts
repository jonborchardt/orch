/**
 * Whether a Claude child ended because its account hit a usage or rate limit, read from what it
 * left (decision 2026-11-24-usage-limit-ends-run-resumably). Pure; the forms are the ones Claude
 * Code is known to print, and a form missed here falls back to an ordinary idle exit.
 */

import { type Model, OWN_ALLOWANCE_MODELS } from './roles.ts';

export interface ClaudeLimit {
  /** A short label: "usage limit" or "rate limit". */
  limit: string;
  /** The reset time exactly as printed, or null when none was given. */
  resetsAt: string | null;
  /**
   * The model whose own allowance ran out, when the text names one of `OWN_ALLOWANCE_MODELS`
   * (decision 2026-11-26-per-model-limit-falls-back); null for an account-wide limit.
   */
  model: Model | null;
}

const OWN = OWN_ALLOWANCE_MODELS.join('|');
/** "Fable limit reached", "You've hit your fable limit". */
const MODEL_FORM = new RegExp(
  `\\b(${OWN}) limit reached|you(?:'|’)?ve hit your (${OWN}) limit`,
  'i',
);

const FORMS: readonly { limit: string; re: RegExp }[] = [
  { limit: 'usage limit', re: MODEL_FORM },
  {
    limit: 'usage limit',
    re: /usage limit reached|\b\d+-hour limit reached|weekly limit reached|you(?:'|’)?ve hit your (?:usage )?limit/i,
  },
  {
    limit: 'rate limit',
    re: /rate_limit_error|\b429 too many requests|api error:? 429\b|status(?: code)?:? 429\b/i,
  },
];

/** `|<epoch>` right after the limit text, or what follows "resets" on the line. */
const RESET = /limit reached\|(\d+)|\bresets\s+(.+)$/i;

function find(text: string): ClaudeLimit | null {
  for (const line of text.split(/\r?\n/)) {
    const form = FORMS.find((f) => f.re.test(line));
    if (form === undefined) continue;
    const m = RESET.exec(line);
    const reset = (m?.[1] ?? m?.[2])?.trim();
    const named = MODEL_FORM.exec(line);
    const model = (named?.[1] ?? named?.[2])?.toLowerCase() as Model | undefined;
    return {
      limit: form.limit,
      resetsAt: reset === undefined || reset === '' ? null : reset,
      model: model ?? null,
    };
  }
  return null;
}

/**
 * The limit a child hit, or null. `stderrTail` is always read; `result.result` only when the
 * result says it is an error, so a session that merely talks about a limit is never one.
 */
export function claudeLimit(
  stderrTail: string | null | undefined,
  result: { isError: boolean | null; result: string | null } | null | undefined,
): ClaudeLimit | null {
  return (
    find(stderrTail ?? '') ??
    (result?.isError === true && result.result !== null ? find(result.result) : null)
  );
}

/** A network failure, "Can't reach the API server", an API 5xx, or an overloaded API. */
const UNREACHABLE =
  /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b|can(?:'|’)?t reach the api server|\bapi error:? 5\d\d\b|\bstatus(?: code)?:? 5\d\d\b|\b5\d\d (?:internal server error|bad gateway|service unavailable|gateway timeout)\b|overloaded/i;

const unreachableLine = (text: string): string | null =>
  text
    .split(/\r?\n/)
    .find((l) => UNREACHABLE.test(l))
    ?.trim() ?? null;

/**
 * The line saying a child could not reach the Claude API (decision
 * 2026-11-26-controller-waits-for-limits), or null. Read like `claudeLimit`: `stderrTail` always,
 * `result.result` only when the result is an error.
 */
export function apiUnreachable(
  stderrTail: string | null | undefined,
  result: { isError: boolean | null; result: string | null } | null | undefined,
): string | null {
  return (
    unreachableLine(stderrTail ?? '') ??
    (result?.isError === true && result.result !== null ? unreachableLine(result.result) : null)
  );
}

/** The ISO time a limit lifts: only the epoch form (`limit reached|<epoch>`) is a known time. */
export function limitUntil(resetsAt: string | null | undefined): string | null {
  if (resetsAt == null || !/^\d{9,11}$/.test(resetsAt)) return null;
  return new Date(Number(resetsAt) * 1000).toISOString();
}
