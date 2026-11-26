/**
 * Plain-language notes on how each model does in each role, made from counts by fixed rules (no
 * model writes them). Pure. Notes advise a person choosing pools; nothing acts on them.
 */

/** Reviews (or jobs) a group needs before it is compared with another. */
export const MIN_SAMPLE = 20;

export type Confidence = 'low' | 'medium' | 'high';

export interface ModelNote {
  role: string;
  text: string;
  /** The smaller sample the note rests on. */
  n: number;
  confidence: Confidence;
}

export function confidenceOf(n: number): Confidence {
  if (n < 50) return 'low';
  return n < 200 ? 'medium' : 'high';
}

/** Two-proportion z statistic of x1/n1 against x2/n2; 0 when the pooled rate is 0 or 1. */
export function zScore(x1: number, n1: number, x2: number, n2: number): number {
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (x1 / n1 - x2 / n2) / se;
}

/** A group of reviews of one role: `label` is a model name or "same author" / "different author". */
export interface RateGroup {
  label: string;
  objections: number;
  reviews: number;
}

const note = (role: string, text: string, n: number): ModelNote => ({
  role,
  text,
  n,
  confidence: confidenceOf(n),
});

const pairs = <T>(xs: readonly T[]): [T, T][] =>
  xs.flatMap((a, i) => xs.slice(i + 1).map((b): [T, T] => [a, b]));

/**
 * Objection-rate notes for one role: counts only for a group below MIN_SAMPLE, and a z-test for
 * each pair of groups that both reach it.
 */
export function rateNotes(role: string, groups: readonly RateGroup[]): ModelNote[] {
  const out: ModelNote[] = [];
  for (const g of groups) {
    if (g.reviews >= MIN_SAMPLE) continue;
    out.push(
      note(
        role,
        `${role} on ${g.label}: ${String(g.objections)} objections in ${String(g.reviews)} reviews; not enough data.`,
        g.reviews,
      ),
    );
  }
  const ready = groups.filter((g) => g.reviews >= MIN_SAMPLE);
  for (const [a, b] of pairs(ready)) {
    const n = Math.min(a.reviews, b.reviews);
    const counts = `${String(a.objections)} objections in ${String(a.reviews)} reviews vs ${String(b.objections)} in ${String(b.reviews)}`;
    const z = zScore(a.objections, a.reviews, b.objections, b.reviews);
    const text =
      Math.abs(z) >= 1.96
        ? `${role} on ${a.label} objects ${z > 0 ? 'more' : 'less'} often than on ${b.label} (${counts}).`
        : `${role} on ${a.label} vs ${b.label}: ${counts}; too few reviews to tell.`;
    out.push(note(role, text, n));
  }
  return out;
}

/** Jobs of one builder-like role on one model; `mean` is tokens per job over `withTokens` jobs. */
export interface TokenGroup {
  label: string;
  jobs: number;
  withTokens: number;
  mean: number | null;
}

/** Counts only below MIN_SAMPLE jobs; a token ratio for each pair whose token samples reach it. */
export function tokenNotes(role: string, groups: readonly TokenGroup[]): ModelNote[] {
  const out: ModelNote[] = [];
  for (const g of groups) {
    if (g.jobs < MIN_SAMPLE) {
      out.push(
        note(role, `${role} on ${g.label}: ${String(g.jobs)} jobs; not enough data.`, g.jobs),
      );
    }
  }
  const ready = groups.filter((g) => g.withTokens >= MIN_SAMPLE && g.mean !== null && g.mean > 0);
  for (const [x, y] of pairs(ready)) {
    const [a, b] = (x.mean ?? 0) >= (y.mean ?? 0) ? [x, y] : [y, x];
    const r = (a.mean ?? 0) / (b.mean ?? 1);
    out.push(
      note(
        role,
        `${role} on ${a.label}: ${r.toFixed(1)}x the tokens of ${b.label} per job.`,
        Math.min(a.withTokens, b.withTokens),
      ),
    );
  }
  return out;
}
