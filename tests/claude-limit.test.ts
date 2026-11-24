import { describe, expect, it } from 'vitest';

import { claudeLimit } from '../src/core/claude-limit.ts';

const error = (result: string) => ({ isError: true, result });

describe('claudeLimit', () => {
  it.each([
    ['Claude AI usage limit reached|1764000000', 'usage limit', '1764000000'],
    ['5-hour limit reached ∙ resets 3pm', 'usage limit', '3pm'],
    ["You've hit your limit · resets 3pm (Europe/Berlin)", 'usage limit', '3pm (Europe/Berlin)'],
    ['YOU’VE HIT YOUR LIMIT', 'usage limit', null],
    [
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}',
      'rate limit',
      null,
    ],
    ['Error: 429 Too Many Requests', 'rate limit', null],
  ])('finds %j in stderr and in an error result', (text, limit, resetsAt) => {
    expect(claudeLimit(`starting\n${text}\n`, null)).toEqual({ limit, resetsAt });
    expect(claudeLimit('', error(text))).toEqual({ limit, resetsAt });
  });

  it('never reads a result that is not an error', () => {
    const text = 'I hit the rate limit, resets 3pm. Claude AI usage limit reached|1764000000';
    expect(claudeLimit('', { isError: false, result: text })).toBeNull();
    expect(claudeLimit(undefined, { isError: null, result: text })).toBeNull();
  });

  it('an ordinary failed or idle exit is no limit', () => {
    expect(
      claudeLimit('Error: ENOENT: no such file\n    at line 429', error('tool failed')),
    ).toBeNull();
    expect(claudeLimit('', null)).toBeNull();
    expect(claudeLimit(undefined, undefined)).toBeNull();
  });
});
