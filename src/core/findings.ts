/**
 * Blocking findings and what became of them (decision 2026-11-25-attributed-findings). Pure:
 * parses a round's consolidated.md into findings with ids `<round>.<k>` and their reviewers, the
 * builder's answers in build.md's `Findings addressed`, and applies the fixed outcome rules the
 * Agents read model counts. `ops/gates.ts` enforces the formats at registration.
 */
import { ValidationError } from './errors.ts';

export interface Finding {
  /** `<round>.<k>`: k is the 1-based ordinal among the round's `[BLOCKING]` lines. */
  id: string;
  reviewers: string[];
}

export type Answer = 'fixed' | 'declined';
export interface FindingAnswer {
  id: string;
  answer: Answer;
}

export type Outcome = 'fixed' | 'declined' | 'overruled' | 'vanished' | 'open';

/** Lines under `heading` up to the next heading of any level. */
function section(content: string, heading: RegExp): string[] {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

const BLOCKING_LINE = /^\s*(?:[-*+]|\d+[.)])?\s*\[BLOCKING\]/;
const TAG = /\(reviewers:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*\)\s*$/i;
const MARKER = /^BLOCKING:\s*(\d+)\s*$/m;

function blockingLines(content: string): string[] {
  return section(content, /^#{1,6}\s*Findings\b/i).filter((l) => BLOCKING_LINE.test(l));
}

const tagOf = (line: string): string[] | null => {
  const m = TAG.exec(line);
  return m?.[1] ? m[1].split(',').map((s) => s.trim().toLowerCase()) : null;
};

/**
 * The round's blocking findings, each attributed; null for a consolidation that is not fully
 * attributed (a legacy one: an untagged `[BLOCKING]` line, or a count that disagrees with the
 * `BLOCKING:` marker). Such a round is "not attributed" and left out of every metric.
 */
export function attributedFindings(round: number, content: string): Finding[] | null {
  const lines = blockingLines(content);
  const tags = lines.map(tagOf);
  if (tags.some((t) => t === null)) return null;
  if (Number(MARKER.exec(content)?.[1] ?? NaN) !== lines.length) return null;
  return tags.map((reviewers, i) => ({
    id: `${String(round)}.${String(i + 1)}`,
    reviewers: reviewers ?? [],
  }));
}

/**
 * Registration rule for round-N/consolidated.md: every `[BLOCKING]` line ends with
 * `(reviewers: <name>[, <name>...])` naming roles that recorded a review row this round, and the
 * line count equals the `BLOCKING:` marker.
 */
export function checkConsolidated(
  round: number,
  content: string,
  reviewed: readonly string[],
): Finding[] {
  const path = `round-${String(round)}/consolidated.md`;
  const lines = blockingLines(content);
  const untagged = lines.flatMap((l, i) => (tagOf(l) === null ? [i + 1] : []));
  if (untagged.length > 0) {
    throw new ValidationError(
      `${path}: blocking finding(s) ${untagged.map((k) => `${String(round)}.${String(k)}`).join(', ')} ` +
        'must end with "(reviewers: <name>[, <name>...])"',
    );
  }
  const marker = Number(MARKER.exec(content)?.[1] ?? NaN);
  if (marker !== lines.length) {
    throw new ValidationError(
      `${path}: BLOCKING: ${String(marker)} but ${String(lines.length)} [BLOCKING] line(s) under Findings`,
    );
  }
  const findings = attributedFindings(round, content) ?? [];
  const unknown = [
    ...new Set(findings.flatMap((f) => f.reviewers).filter((r) => !reviewed.includes(r))),
  ];
  if (unknown.length > 0) {
    throw new ValidationError(
      `${path}: reviewers tag names ${unknown.join(', ')}, which recorded no review in round ${String(round)}` +
        ` (recorded: ${reviewed.join(', ') || 'none'})`,
    );
  }
  return findings;
}

const ANSWER_LINE = /^\s*[-*]\s*(\d+\.\d+)\s*:\s*(.*)$/;

/** Answer lines under build.md's `Findings addressed`; `bad` lists ids whose answer is malformed. */
export function parseAnswers(content: string): { answers: FindingAnswer[]; bad: string[] } {
  const answers: FindingAnswer[] = [];
  const bad: string[] = [];
  for (const line of section(content, /^#{1,6}\s*Findings addressed\b/i)) {
    const m = ANSWER_LINE.exec(line);
    if (!m?.[1]) continue;
    const text = m[2] ?? '';
    if (/^fixed\b/i.test(text)) answers.push({ id: m[1], answer: 'fixed' });
    else if (/^declined\s*(?:—|–|-|:)\s*\S/i.test(text))
      answers.push({ id: m[1], answer: 'declined' });
    else bad.push(m[1]);
  }
  return { answers, bad };
}

/** Registration rule for build.md: each of `findings` answered exactly once, and nothing else. */
export function checkAnswers(findings: readonly Finding[], content: string): FindingAnswer[] {
  const { answers, bad } = parseAnswers(content);
  const ids = findings.map((f) => f.id);
  const seen = answers.map((a) => a.id);
  const problems: string[] = [];
  const missing = ids.filter((id) => !seen.includes(id) && !bad.includes(id));
  if (missing.length > 0) problems.push(`unanswered: ${missing.join(', ')}`);
  const unknown = [...new Set([...seen, ...bad].filter((id) => !ids.includes(id)))];
  if (unknown.length > 0) problems.push(`unknown id(s): ${unknown.join(', ')}`);
  const twice = [...new Set(seen.filter((id, i) => seen.indexOf(id) !== i))];
  if (twice.length > 0) problems.push(`answered more than once: ${twice.join(', ')}`);
  const malformed = bad.filter((id) => ids.includes(id));
  if (malformed.length > 0) {
    problems.push(`not "fixed" or "declined — <reason>": ${malformed.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new ValidationError(
      `build.md: Findings addressed must answer each blocking finding once as "- <id>: fixed" or ` +
        `"- <id>: declined — <reason>"; ${problems.join('; ')}`,
    );
  }
  return answers;
}

/**
 * What became of one finding. `answer` is its latest answer and when it was registered;
 * `approvedAt` is when decision.md was last registered as APPROVE, if it was.
 */
export function findingOutcome(
  answer: { answer: Answer; at: string } | undefined,
  job: { finished: boolean; approvedAt: string | null },
): Outcome {
  if (!answer) return job.finished ? 'vanished' : 'open';
  if (answer.answer === 'fixed') return 'fixed';
  return job.approvedAt !== null && job.approvedAt >= answer.at ? 'overruled' : 'declined';
}

/** A raising reviewer's credit for one finding; null for an open one (counted nowhere). */
export type Credit = 'real-catch' | 'fixed' | 'unresolved' | 'declined' | 'overruled' | 'vanished';

/**
 * A fixed finding is a real catch when the raising reviewer passed the next review round, plain
 * fixed when it asked for changes again, and unresolved when it gave no verdict there.
 */
export function creditOf(outcome: Outcome, nextVerdict: 'pass' | 'changes' | null): Credit | null {
  if (outcome === 'open') return null;
  if (outcome !== 'fixed') return outcome;
  if (nextVerdict === null) return 'unresolved';
  return nextVerdict === 'pass' ? 'real-catch' : 'fixed';
}
