/**
 * The source-controlled skill and agents must agree with the code: every role has an agent file
 * with valid frontmatter and the same default model, the reference templates satisfy the artifact
 * rules, and `orch install` links them all into an isolated Claude directory.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runInstall } from '../src/cli/install.ts';
import { checkArtifact } from '../src/core/artifact-rules.ts';
import { installRoot } from '../src/core/paths.ts';
import { MODELS, ROLES } from '../src/core/roles.ts';
import { tempDir } from './helpers.ts';

const root = installRoot();
const agentsDir = join(root, 'agents');
const skillDir = join(root, 'skills', 'factory');

function frontmatter(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) throw new Error(`${file} has no frontmatter`);
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('agents', () => {
  it('every role has an agent file whose frontmatter matches the roles table', () => {
    for (const role of ROLES) {
      const file = join(agentsDir, `${role.agent}.md`);
      expect(existsSync(file), file).toBe(true);
      const fm = frontmatter(file);
      expect(fm['name']).toBe(role.agent);
      expect(fm['model']).toBe(role.model);
      expect(MODELS).toContain(fm['model']);
      expect(fm['description']?.length ?? 0).toBeGreaterThan(40);
      expect(fm['tools']).toBeTruthy();
    }
    const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    expect(files.sort()).toEqual(ROLES.map((r) => `${r.agent}.md`).sort());
  });

  it('reviewers and the approver cannot edit code; the builder can', () => {
    const tools = (agent: string) =>
      (frontmatter(join(agentsDir, `${agent}.md`))['tools'] ?? '').split(/,\s*/);
    for (const r of ROLES.filter((x) => x.kind === 'review')) {
      expect(tools(r.agent)).not.toContain('Edit');
      expect(tools(r.agent)).toContain('Write'); // its own review artifact
      const text = readFileSync(join(agentsDir, `${r.agent}.md`), 'utf8');
      expect(text).toContain('VERDICT');
      // Phase 1 validation (issues I-01): reviewers answered inline instead of writing the file
      // when the harness discouraged report files; the agent must say the file is the deliverable.
      expect(text).toContain('The review file is the deliverable');
    }
    expect(tools('factory-approver')).not.toContain('Edit');
    expect(tools('factory-approver')).not.toContain('Write');
    expect(tools('factory-builder')).toContain('Edit');
    expect(tools('factory-spec-writer')).not.toContain('Edit');
  });
});

describe('skill', () => {
  it('has frontmatter and drives the workflow through orch commands only', () => {
    const fm = frontmatter(join(skillDir, 'SKILL.md'));
    expect(fm['name']).toBe('factory');
    expect(fm['description']).toContain('/factory');
    const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    for (const cmd of [
      'orch factory start',
      'orch factory dispatch',
      'orch factory list',
      'orch factory next',
      'orch factory resume',
      'orch factory check-readonly',
      'orch job session attach',
      '--adopt',
      'orch job transition',
      'orch job review record',
      'orch job artifact add',
      'orch gh pr status',
      'orch gh ci',
    ]) {
      expect(body, cmd).toContain(cmd);
    }
    expect(body).not.toMatch(/sqlite3|INSERT INTO|UPDATE jobs/);
    expect(body).toContain('--force');
    expect(body.toLowerCase()).toContain('cannot restart');
  });

  it('reference templates satisfy the artifact rules the CLI enforces', () => {
    const text = readFileSync(join(skillDir, 'reference.md'), 'utf8');
    const template = (heading: string): string => {
      const start = text.indexOf(`\n## ${heading}`);
      expect(start, heading).toBeGreaterThan(0);
      const open = text.indexOf('```markdown', start);
      const close = text.indexOf('```', open + 11);
      return text.slice(open + 11, close);
    };
    expect(checkArtifact('spec.md', template('spec.md'))).toBeNull();
    expect(checkArtifact('build.md', template('build.md'))).toBeNull();
    expect(checkArtifact('round-1/review-ux.md', template('round-N/review-<reviewer>.md'))).toBe(
      'pass',
    );
    expect(checkArtifact('round-1/consolidated.md', template('round-N/consolidated.md'))).toBe('1');
    expect(checkArtifact('decision.md', template('decision.md'))).toBe('approve');
    expect(checkArtifact('pr.md', template('pr.md (also used as the PR body)'))).toBeNull();
  });
});

describe('orch install with the real skill and agents', () => {
  it('links the factory skill and every agent into an isolated Claude directory', () => {
    const claude = tempDir('orch-claude-real-');
    dirs.push(claude);
    const dry = runInstall({ source: root, 'claude-dir': claude, 'dry-run': true });
    expect(dry.problems).toBe(false);
    expect(dry.entries.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(
      ['skill:factory', ...ROLES.map((r) => `agent:${r.agent}`)].sort(),
    );
    const real = runInstall({ source: root, 'claude-dir': claude });
    expect(real.problems).toBe(false);
    expect(real.entries.every((e) => e.state === 'linked')).toBe(true);
    expect(readFileSync(join(claude, 'skills', 'factory', 'SKILL.md'), 'utf8')).toContain(
      'name: factory',
    );
    expect(existsSync(join(claude, 'skills', 'factory', 'reference.md'))).toBe(true);
    expect(frontmatter(join(claude, 'agents', 'factory-builder.md'))['name']).toBe(
      'factory-builder',
    );
    // Repeating is a no-op and the links still resolve to this repository.
    const again = runInstall({ source: root, 'claude-dir': claude });
    expect(again.entries.map((e) => e.state)).toEqual(real.entries.map(() => 'linked'));
  });
});
