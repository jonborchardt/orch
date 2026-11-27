import { describe, expect, it } from 'vitest';

import { claudeLimit, limitUntil } from '../src/core/claude-limit.ts';

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
    expect(claudeLimit(`starting\n${text}\n`, null)).toEqual({ limit, resetsAt, model: null });
    expect(claudeLimit('', error(text))).toEqual({ limit, resetsAt, model: null });
  });

  // Best-known forms: no real fable exhaustion text could be collected (ticket 0179).
  it.each([
    ['Fable limit reached', null],
    ['Fable limit reached|1764000000', '1764000000'],
    ['Fable limit reached ∙ resets 3pm', '3pm'],
    ["You've hit your fable limit", null],
    ['You’ve hit your Fable limit · resets 3pm (Europe/Berlin)', '3pm (Europe/Berlin)'],
  ])('names the model of an own-allowance limit: %j', (text, resetsAt) => {
    const want = { limit: 'usage limit', resetsAt, model: 'fable' };
    expect(claudeLimit(`starting\n${text}\n`, null)).toEqual(want);
    expect(claudeLimit('', error(text))).toEqual(want);
  });

  it('a limit naming a model without its own allowance names none', () => {
    // Not a recognised form today: an ordinary exit, as before.
    expect(claudeLimit('Opus limit reached ∙ now using Sonnet', null)?.model ?? null).toBeNull();
    expect(claudeLimit('Opus weekly limit reached ∙ resets Mon', null)).toEqual({
      limit: 'usage limit',
      resetsAt: 'Mon',
      model: null,
    });
  });

  it('only an epoch reset is a known time', () => {
    expect(limitUntil('1764000000')).toBe(new Date(1764000000 * 1000).toISOString());
    for (const t of ['3pm', '3pm (Europe/Berlin)', '', null, undefined]) {
      expect(limitUntil(t)).toBeNull();
    }
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
