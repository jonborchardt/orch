import { describe, expect, it } from 'vitest';

import { checkArtifact, ruleFor } from '../src/core/artifact-rules.ts';
import { ValidationError } from '../src/core/errors.ts';
import { jobWorktreeDir, repoSlug } from '../src/core/paths.ts';
import { fixture, homePaths } from './helpers.ts';

describe('artifact rules', () => {
  it('maps workflow paths to rules and leaves other files unconstrained', () => {
    expect(ruleFor('spec.md')?.headings).toContain('Goal');
    expect(ruleFor('round-12/review-web-platform.md')?.marker?.name).toBe('VERDICT');
    expect(ruleFor('round-1/consolidated.md')?.marker?.name).toBe('BLOCKING');
    expect(ruleFor('notes.md')).toBeUndefined();
    expect(checkArtifact('notes.md', 'anything')).toBeNull();
    expect(checkArtifact('round-1/evidence/axe.md', '')).toBeNull();
  });

  it('accepts the fixtures and returns lower-cased markers', () => {
    expect(checkArtifact('spec.md', fixture('spec.md'))).toBeNull();
    expect(checkArtifact('build.md', fixture('build.md'))).toBeNull();
    expect(checkArtifact('round-1/review-security.md', fixture('round-1/review-x.md'))).toBe(
      'pass',
    );
    expect(checkArtifact('round-2/review-ux.md', fixture('round-2/review-ux.md', 'CHANGES'))).toBe(
      'changes',
    );
    expect(checkArtifact('round-1/consolidated.md', fixture('round-1/consolidated.md', '3'))).toBe(
      '3',
    );
    expect(checkArtifact('decision.md', fixture('decision.md', 'ESCALATE'))).toBe('escalate');
    expect(checkArtifact('pr.md', fixture('pr.md'))).toBeNull();
  });

  it('headings are case-insensitive and any level; markers must appear exactly once', () => {
    expect(
      checkArtifact('spec.md', '# GOAL\nx\n### scope\ny\n## Acceptance Criteria (testable)\nz\n'),
    ).toBeNull();
    expect(() => checkArtifact('spec.md', '# Goal\n## Scope\n## Acceptance\n')).toThrow(
      /"Acceptance criteria"/,
    );
    const review = '## Findings\n- a\n\nVERDICT: PASS\nVERDICT: CHANGES\n';
    expect(() => checkArtifact('round-1/review-a.md', review)).toThrow(/exactly one/);
    expect(() =>
      checkArtifact('round-1/review-a.md', '## Findings\nVERDICT: pass\n'),
    ).not.toThrow();
    expect(() => checkArtifact('round-1/review-a.md', '## Findings\nVERDICT: MAYBE\n')).toThrow(
      ValidationError,
    );
    // Marker inside prose does not count: it must be a whole line.
    expect(() =>
      checkArtifact('decision.md', '## Rationale\nI write DECISION: APPROVE here\n'),
    ).toThrow(/exactly one/);
  });

  it('spec challenges: spec-review-1.md and -2.md only, Findings plus one VERDICT', () => {
    expect(checkArtifact('spec-review-1.md', fixture('spec-review-1.md'))).toBe('pass');
    expect(checkArtifact('spec-review-2.md', fixture('spec-review-2.md', 'CHANGES'))).toBe(
      'changes',
    );
    expect(ruleFor('spec-review-1.md')?.stage).toBe('spec');
    expect(() => checkArtifact('spec-review-1.md', '# Review\n\nVERDICT: PASS\n')).toThrow(
      /"Findings"/,
    );
    expect(() => checkArtifact('spec-review-1.md', '## Findings\nnone\n')).toThrow(/exactly one/);
    expect(() =>
      checkArtifact('spec-review-1.md', '## Findings\nVERDICT: PASS\nVERDICT: CHANGES\n'),
    ).toThrow(/exactly one/);
    expect(() => checkArtifact('spec-review-2.md', '## Findings\nVERDICT: MAYBE\n')).toThrow(
      ValidationError,
    );
    expect(ruleFor('spec-review-3.md')).toBeUndefined();
    expect(ruleFor('round-1/spec-review-1.md')).toBeUndefined();
  });
});

describe('worktree paths', () => {
  it('slugs repository identities and keeps worktrees under the data dir', () => {
    expect(repoSlug('github.com/Acme/Alpha')).toBe('github.com-Acme-Alpha');
    expect(repoSlug('c/users/jon/my repo')).toBe('c-users-jon-my-repo');
    expect(repoSlug('///')).toBe('repo');
    const dir = jobWorktreeDir('job-1', 'github.com/o/r', homePaths('/home'));
    expect(dir.split(/[\\/]/).slice(-3)).toEqual(['worktrees', 'github.com-o-r', 'job-1']);
  });
});
