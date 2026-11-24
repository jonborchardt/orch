/**
 * Whether a Claude child ended because its account hit a usage or rate limit, read from what it
 * left (decision 2026-11-24-usage-limit-ends-run-resumably). Pure; the forms are the ones Claude
 * Code is known to print, and a form missed here falls back to an ordinary idle exit.
 */

export interface ClaudeLimit {
  /** A short label: "usage limit" or "rate limit". */
  limit: string;
  /** The reset time exactly as printed, or null when none was given. */
  resetsAt: string | null;
}

const FORMS: readonly { limit: string; re: RegExp }[] = [
  {
    limit: 'usage limit',
    re: /usage limit reached|\b\d+-hour limit reached|weekly limit reached|you(?:'|’)?ve hit your (?:usage )?limit/i,
  },
  {
    limit: 'rate limit',
    re: /rate_limit_error|\b429 too many requests|api error:? 429\b|status(?: code)?:? 429\b/i,
  },
];

/** `|<epoch>` right after the usage-limit text, or what follows "resets" on the line. */
const RESET = /usage limit reached\|(\d+)|\bresets\s+(.+)$/i;

function find(text: string): ClaudeLimit | null {
  for (const line of text.split(/\r?\n/)) {
    const form = FORMS.find((f) => f.re.test(line));
    if (form === undefined) continue;
    const m = RESET.exec(line);
    const reset = (m?.[1] ?? m?.[2])?.trim();
    return { limit: form.limit, resetsAt: reset === undefined || reset === '' ? null : reset };
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
