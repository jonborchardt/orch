/** Rule-based notes on models per role (ticket 0169, AC5). Pure. */
import { describe, expect, it } from 'vitest';

import {
  confidenceOf,
  MIN_SAMPLE,
  rateNotes,
  tokenNotes,
  zScore,
} from '../src/core/model-notes.ts';

describe('model notes', () => {
  it('gives only counts below the minimum sample, and no comparison', () => {
    expect(MIN_SAMPLE).toBe(20);
    const notes = rateNotes('security', [
      { label: 'opus', objections: 3, reviews: 19 },
      { label: 'sonnet', objections: 9, reviews: 40 },
    ]);
    expect(notes).toEqual([
      {
        role: 'security',
        text: 'security on opus: 3 objections in 19 reviews; not enough data.',
        n: 19,
        confidence: 'low',
      },
    ]);
  });

  it("the ticket's example is too few reviews to tell, with n and the label", () => {
    expect(Math.abs(zScore(0, 41, 2, 40))).toBeLessThan(1.96);
    expect(
      rateNotes('correctness', [
        { label: 'sonnet', objections: 0, reviews: 41 },
        { label: 'opus', objections: 2, reviews: 40 },
      ]),
    ).toEqual([
      {
        role: 'correctness',
        text: 'correctness on sonnet vs opus: 0 objections in 41 reviews vs 2 in 40; too few reviews to tell.',
        n: 40,
        confidence: 'low',
      },
    ]);
  });

  it('states the direction of a clear difference, and a token ratio', () => {
    const [less] = rateNotes('security', [
      { label: 'haiku', objections: 5, reviews: 100 },
      { label: 'opus', objections: 40, reviews: 100 },
    ]);
    expect(less).toEqual({
      role: 'security',
      text: 'security on haiku objects less often than on opus (5 objections in 100 reviews vs 40 in 100).',
      n: 100,
      confidence: 'medium',
    });
    const [more] = rateNotes('security', [
      { label: 'opus', objections: 40, reviews: 100 },
      { label: 'haiku', objections: 5, reviews: 100 },
    ]);
    expect(more?.text).toContain('security on opus objects more often than on haiku');

    expect(
      tokenNotes('builder', [
        { label: 'opus', jobs: 30, withTokens: 25, mean: 1000 },
        { label: 'fable', jobs: 30, withTokens: 20, mean: 1400 },
      ]),
    ).toEqual([
      {
        role: 'builder',
        text: 'builder on fable: 1.4x the tokens of opus per job.',
        n: 20,
        confidence: 'low',
      },
    ]);
    // Below the minimum in jobs: counts only; too few token samples: no ratio.
    expect(
      tokenNotes('builder', [
        { label: 'opus', jobs: 5, withTokens: 5, mean: 1000 },
        { label: 'fable', jobs: 30, withTokens: 10, mean: 1400 },
      ]).map((n) => n.text),
    ).toEqual(['builder on opus: 5 jobs; not enough data.']);
  });

  it('switches confidence at 49/50 and 199/200', () => {
    expect([49, 50, 199, 200].map(confidenceOf)).toEqual(['low', 'medium', 'medium', 'high']);
  });
});
