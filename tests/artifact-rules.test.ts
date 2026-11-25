import { describe, expect, it } from 'vitest';

import { assertStageOwns, checkArtifact, ruleFor } from '../src/core/artifact-rules.ts';
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

  it('decision.md accepts the two scope-gap rework outcomes and nothing else new', () => {
    expect(checkArtifact('decision.md', fixture('decision.md', 'REWORK-BUILD'))).toBe(
      'rework-build',
    );
    expect(checkArtifact('decision.md', fixture('decision.md', 'REWORK-SPEC'))).toBe('rework-spec');
    for (const bad of ['REWORK', 'REWORK-PR', 'CHANGES']) {
      expect(() => checkArtifact('decision.md', fixture('decision.md', bad))).toThrow(
        /DECISION must be one of APPROVE, ESCALATE, REWORK-BUILD, REWORK-SPEC/,
      );
    }
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

  it('simplify: findings need Findings; the record needs Applied, Declined, and Validation', () => {
    expect(checkArtifact('round-1/simplify-review.md', '# S\n\n## Findings\nNone.\n')).toBeNull();
    const record = '## Applied\nnone\n\n## Declined\n1. kept: spec needs it\n\n## Validation\nok\n';
    expect(checkArtifact('round-1/simplify.md', record)).toBeNull();
    expect(() => checkArtifact('round-1/simplify-review.md', '# S\nnothing\n')).toThrow(
      /"Findings"/,
    );
    for (const h of ['Applied', 'Declined', 'Validation']) {
      const without = record.replace(`## ${h}`, '## Other');
      expect(() => checkArtifact('round-1/simplify.md', without), h).toThrow(`"${h}"`);
    }
    // The findings file is not a reviewer file: no VERDICT, and it belongs to simplify.
    expect(ruleFor('round-1/simplify-review.md')?.stage).toBe('simplify');
    expect(ruleFor('round-1/simplify-review.md')?.marker).toBeUndefined();
    for (const p of ['round-2/simplify-review.md', 'round-2/simplify.md']) {
      const owns = (stage: 'simplify' | 'review' | 'build', round: number) => () => {
        assertStageOwns(p, stage, round);
      };
      expect(owns('simplify', 2)).not.toThrow();
      expect(owns('simplify', 1)).toThrow(/round 2/);
      expect(owns('review', 2)).toThrow(/simplify stage/);
      expect(owns('build', 2)).toThrow(ValidationError);
    }
  });

  it('lets a spec escalation re-register spec.md and nothing else', () => {
    expect(() => {
      assertStageOwns('spec.md', 'needs-human', 0, 'spec');
    }).not.toThrow();
    expect(() => {
      assertStageOwns('spec.md', 'needs-human', 0, 'build');
    }).toThrow(ValidationError);
    expect(() => {
      assertStageOwns('spec-review-1.md', 'needs-human', 0, 'spec');
    }).toThrow(ValidationError);
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
