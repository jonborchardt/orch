/**
 * Required structure of workflow artifacts. Pure: takes a relative path and file content,
 * throws ValidationError when a required section or marker is missing, and returns the marker
 * value the workflow depends on (review verdict, approval decision, blocking-finding count).
 *
 * The transition rules in workflow.ts consume these markers, so a review recorded as `pass`
 * whose file says `VERDICT: CHANGES`, or an approve stage completed with a `DECISION: ESCALATE`
 * file, is refused in code rather than only in skill prose.
 */
import { ValidationError } from './errors.ts';

export interface ArtifactRule {
  /** Matches the relative artifact path (forward slashes). */
  path: RegExp;
  /** Headings that must be present (case-insensitive, any level). */
  headings: string[];
  /** `MARKER_NAME: value` line that must be present once, and the allowed values. */
  marker?: { name: string; values?: readonly string[]; pattern?: RegExp } | undefined;
}

export const ARTIFACT_RULES: readonly ArtifactRule[] = [
  { path: /^spec\.md$/, headings: ['Goal', 'Scope', 'Acceptance criteria'] },
  { path: /^build\.md$/, headings: ['Summary', 'Validation'] },
  {
    path: /^round-\d+\/review-[a-z0-9-]+\.md$/,
    headings: ['Findings'],
    marker: { name: 'VERDICT', values: ['PASS', 'CHANGES'] },
  },
  {
    path: /^round-\d+\/consolidated\.md$/,
    headings: ['Findings'],
    marker: { name: 'BLOCKING', pattern: /^\d+$/ },
  },
  {
    path: /^decision\.md$/,
    headings: ['Rationale'],
    marker: { name: 'DECISION', values: ['APPROVE', 'ESCALATE'] },
  },
  { path: /^pr\.md$/, headings: ['Validation', 'Known limitations'] },
];

export function ruleFor(relPath: string): ArtifactRule | undefined {
  return ARTIFACT_RULES.find((r) => r.path.test(relPath));
}

function hasHeading(content: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^#{1,6}\\s*${escaped}\\b`, 'im').test(content);
}

/**
 * Validate `content` for `relPath`. Paths without a rule (supporting evidence, notes) are
 * accepted and return no marker. Markers are returned lower-cased.
 */
export function checkArtifact(relPath: string, content: string): string | null {
  const rule = ruleFor(relPath);
  if (!rule) return null;
  const missing = rule.headings.filter((h) => !hasHeading(content, h));
  if (missing.length > 0) {
    throw new ValidationError(
      `${relPath} is missing required section(s): ${missing.map((h) => `"${h}"`).join(', ')}`,
    );
  }
  if (!rule.marker) return null;
  const { name, values, pattern } = rule.marker;
  const lines = [...content.matchAll(new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'gm'))];
  if (lines.length !== 1) {
    const expect = values ? values.join(' | ') : (pattern?.source ?? 'value');
    throw new ValidationError(
      `${relPath} must contain exactly one line "${name}: <${expect}>" (found ${String(lines.length)})`,
    );
  }
  const value = lines[0]?.[1] ?? '';
  if (values && !values.includes(value.toUpperCase())) {
    throw new ValidationError(`${relPath}: ${name} must be one of ${values.join(', ')}`);
  }
  if (pattern && !pattern.test(value)) {
    throw new ValidationError(`${relPath}: ${name} must match ${pattern.source}`);
  }
  return value.toLowerCase();
}
