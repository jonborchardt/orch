/** Attributed blocking findings (ticket 0169): parsing, registration rules, outcomes. Pure. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  attributedFindings,
  checkAnswers,
  checkConsolidated,
  creditOf,
  findingOutcome,
  parseAnswers,
} from '../src/core/findings.ts';

const consolidation = (findings: string, blocking: number) =>
  `# Consolidated findings (round 2)\n\n## Findings\n\n${findings}\n\n## Dropped\n\n- [BLOCKING] not a finding (reviewers: ux)\n\nBLOCKING: ${String(blocking)}\n`;

const MIXED = [
  '1. [MAJOR] a.ts:1 — slow → cache (reviewers: correctness)',
  '2. [BLOCKING] b.ts:2 — wrong → fix (reviewers: security, correctness)',
  '3. [MINOR] c.ts:3 — style → rename',
  '7. [BLOCKING] d.ts:4 — missing AC2 → implement (reviewers: code-quality)',
  '- [BLOCKING] e.ts:5 — leak → close (reviewers: security)',
].join('\n');

describe('parsing consolidated findings (AC1)', () => {
  it('parses the reference template', () => {
    const text = readFileSync(join('skills', 'factory', 'reference.md'), 'utf8');
    const start = text.indexOf('\n## round-N/consolidated.md');
    const open = text.indexOf('```markdown', start);
    const template = text.slice(open + 11, text.indexOf('```', open + 11));
    expect(attributedFindings(1, template)).toEqual([
      { id: '1.1', reviewers: ['correctness', 'security'] },
    ]);
    expect(checkConsolidated(1, template, ['security', 'correctness'])).toHaveLength(1);
  });

  it('numbers only BLOCKING lines under Findings, in file order, with their reviewers', () => {
    const findings = [
      { id: '2.1', reviewers: ['security', 'correctness'] },
      { id: '2.2', reviewers: ['code-quality'] },
      { id: '2.3', reviewers: ['security'] },
    ];
    expect(attributedFindings(2, consolidation(MIXED, 3))).toEqual(findings);
    expect(
      checkConsolidated(2, consolidation(MIXED, 3), ['security', 'correctness', 'code-quality']),
    ).toEqual(findings);
    expect(attributedFindings(2, consolidation('none', 0))).toEqual([]);
  });

  it('refuses a missing tag, an unknown reviewer, and a count that disagrees with the marker', () => {
    const all = ['security', 'correctness', 'code-quality'];
    const untagged = MIXED.replace('(reviewers: code-quality)', '(code-quality)');
    expect(() => checkConsolidated(2, consolidation(untagged, 3), all)).toThrow(
      /blocking finding\(s\) 2\.2 must end with "\(reviewers:/,
    );
    expect(() =>
      checkConsolidated(2, consolidation(MIXED, 3), ['security', 'correctness']),
    ).toThrow(/names code-quality, which recorded no review in round 2/);
    expect(() => checkConsolidated(2, consolidation(MIXED, 2), all)).toThrow(
      /BLOCKING: 2 but 3 \[BLOCKING\] line\(s\)/,
    );
    // At read time the same files are "not attributed".
    expect(attributedFindings(2, consolidation(untagged, 3))).toBeNull();
    expect(attributedFindings(2, consolidation(MIXED, 2))).toBeNull();
  });
});

describe("the builder's answers", () => {
  const findings = [
    { id: '1.1', reviewers: ['security'] },
    { id: '1.2', reviewers: ['correctness'] },
  ];
  const build = (lines: string) =>
    `# Build\n\n## Summary\nS\n\n## Findings addressed\n\n${lines}\n\n## Known gaps\n\n- 1.9: fixed\n`;

  it('reads fixed and declined answers from Findings addressed only', () => {
    expect(parseAnswers(build('- 1.1: fixed — renamed\n- 1.2: declined — out of scope'))).toEqual({
      answers: [
        { id: '1.1', answer: 'fixed' },
        { id: '1.2', answer: 'declined' },
      ],
      bad: [],
    });
    expect(checkAnswers(findings, build('- 1.1: fixed\n- 1.2: declined - no'))).toHaveLength(2);
  });

  it('names unanswered, unknown, repeated, and malformed ids', () => {
    expect(() => checkAnswers(findings, build('- 1.1: fixed'))).toThrow(/unanswered: 1\.2/);
    expect(() => checkAnswers(findings, build('- 1.1: fixed\n- 1.2: fixed\n- 2.1: fixed'))).toThrow(
      /unknown id\(s\): 2\.1/,
    );
    expect(() => checkAnswers(findings, build('- 1.1: fixed\n- 1.1: fixed\n- 1.2: fixed'))).toThrow(
      /answered more than once: 1\.1/,
    );
    expect(() => checkAnswers(findings, build('- 1.1: fixed\n- 1.2: declined'))).toThrow(
      /not "fixed" or "declined — <reason>": 1\.2/,
    );
  });
});

describe('outcomes (AC3)', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const later = '2026-01-02T00:00:00.000Z';
  const active = { finished: false, approvedAt: null };

  it('gives each outcome', () => {
    expect(findingOutcome({ answer: 'fixed', at }, active)).toBe('fixed');
    expect(findingOutcome({ answer: 'declined', at }, active)).toBe('declined');
    expect(findingOutcome({ answer: 'declined', at }, { finished: true, approvedAt: null })).toBe(
      'declined',
    );
    expect(findingOutcome({ answer: 'declined', at }, { finished: true, approvedAt: later })).toBe(
      'overruled',
    );
    // An approval registered before the answer does not overrule it.
    expect(
      findingOutcome({ answer: 'declined', at: later }, { finished: false, approvedAt: at }),
    ).toBe('declined');
    expect(findingOutcome(undefined, { finished: true, approvedAt: null })).toBe('vanished');
    expect(findingOutcome(undefined, active)).toBe('open');
  });

  it('credits the raising reviewer by its next-round verdict', () => {
    expect(creditOf('fixed', 'pass')).toBe('real-catch');
    expect(creditOf('fixed', 'changes')).toBe('fixed');
    expect(creditOf('fixed', null)).toBe('unresolved');
    for (const o of ['declined', 'overruled', 'vanished'] as const) {
      expect(creditOf(o, 'pass')).toBe(o);
    }
    expect(creditOf('open', null)).toBeNull();
  });

  it('an untagged consolidation is not attributed', () => {
    const legacy =
      '# C\n\n## Findings\n\n1. [BLOCKING] a.ts — x → y (correctness, security)\n\nBLOCKING: 1\n';
    expect(attributedFindings(1, legacy)).toBeNull();
  });
});
