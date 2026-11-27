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
import type { Stage } from './workflow.ts';

export interface ArtifactRule {
  /** Matches the relative artifact path (forward slashes). */
  path: RegExp;
  /** The only stage in which this artifact may be registered or replaced. */
  stage: Stage;
  /** Headings that must be present (case-insensitive, any level). */
  headings: string[];
  /** `MARKER_NAME: value` line that must be present once, and the allowed values. */
  marker?: { name: string; values?: readonly string[]; pattern?: RegExp } | undefined;
}

/** The spec challenger's verdicts; also how the Agents read model counts its runs. */
export const SPEC_REVIEW_PATH = /^spec-review-[1-3]\.md$/; // the slots of CHALLENGE in workflow.ts

export const ARTIFACT_RULES: readonly ArtifactRule[] = [
  { path: /^spec\.md$/, stage: 'spec', headings: ['Goal', 'Scope', 'Acceptance criteria'] },
  {
    // The independent spec challenge: one review, one more after a revision, nothing else.
    path: SPEC_REVIEW_PATH,
    stage: 'spec',
    headings: ['Findings'],
    marker: { name: 'VERDICT', values: ['PASS', 'CHANGES'] },
  },
  { path: /^build\.md$/, stage: 'build', headings: ['Summary', 'Validation'] },
  // The simplify pass: the simplifier's findings, then the builder's record of what it applied.
  { path: /^round-\d+\/simplify-review\.md$/, stage: 'simplify', headings: ['Findings'] },
  {
    path: /^round-\d+\/simplify\.md$/,
    stage: 'simplify',
    headings: ['Applied', 'Declined', 'Validation'],
  },
  {
    path: /^round-\d+\/review-[a-z0-9-]+\.md$/,
    stage: 'review',
    headings: ['Findings'],
    marker: { name: 'VERDICT', values: ['PASS', 'CHANGES'] },
  },
  {
    path: /^round-\d+\/consolidated\.md$/,
    stage: 'review',
    headings: ['Findings'],
    marker: { name: 'BLOCKING', pattern: /^\d+$/ },
  },
  {
    path: /^decision\.md$/,
    stage: 'approve',
    headings: ['Rationale'],
    // REWORK-BUILD: the code is less than the spec; REWORK-SPEC: the spec is less than the request.
    marker: { name: 'DECISION', values: ['APPROVE', 'ESCALATE', 'REWORK-BUILD', 'REWORK-SPEC'] },
  },
  { path: /^pr\.md$/, stage: 'pr', headings: ['Validation', 'Known limitations'] },
];

export function ruleFor(relPath: string): ArtifactRule | undefined {
  return ARTIFACT_RULES.find((r) => r.path.test(relPath));
}

/**
 * Workflow artifacts belong to one stage (and, under round-N/, one round): they can only be
 * registered or replaced while the job is there, so nothing rewrites accepted evidence later.
 * Paths without a rule (evidence, notes) are free. One exception: a spec escalation (needs-human
 * returning to spec) may re-register spec.md, the human's edit, which the challenger then reviews
 * (decision 2026-11-25-edit-spec-in-needs-human).
 */
export function assertStageOwns(
  relPath: string,
  stage: Stage,
  round: number,
  returnStage: Stage | null = null,
): void {
  const rule = ruleFor(relPath);
  if (!rule) return;
  if (relPath === 'spec.md' && stage === 'needs-human' && returnStage === 'spec') return;
  const m = /^round-(\d+)\//.exec(relPath);
  const wrongRound = m !== null && Number(m[1]) !== round;
  if (rule.stage !== stage || wrongRound) {
    throw new ValidationError(
      `${relPath} belongs to the ${rule.stage} stage${m ? ` of round ${m[1] ?? '?'}` : ''}; ` +
        `the job is in ${stage}${stage === 'review' || stage === 'simplify' ? ` round ${String(round)}` : ''}.`,
    );
  }
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
