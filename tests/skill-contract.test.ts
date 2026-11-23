/**
 * The source-controlled skill and agents must agree with the code: every role has an agent file
 * with valid frontmatter and the same default model, the reference templates satisfy the artifact
 * rules, and `orch install` links them all into an isolated Claude directory.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FACTORY_HELP } from '../src/cli/factory.ts';
import { runInstall } from '../src/cli/install.ts';
import { JOB_HELP } from '../src/cli/job.ts';
import { TICKET_HELP } from '../src/cli/ticket.ts';
import { checkArtifact } from '../src/core/artifact-rules.ts';
import { installRoot } from '../src/core/paths.ts';
import { MODELS, ROLES } from '../src/core/roles.ts';
import { MERGE_BLOCKS } from '../src/core/workflow.ts';
import { MERGE_OUTCOMES } from '../src/ops/merge.ts';
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
      // Validation runs saw reviewers answer inline instead of writing the file when the harness
      // discouraged report files; every agent that writes an artifact says the file is the deliverable.
      expect(text).toContain('The review file is the deliverable');
    }
    expect(tools('factory-approver')).not.toContain('Edit');
    expect(tools('factory-approver')).toContain('Write'); // decision.md only
    expect(readFileSync(join(agentsDir, 'factory-approver.md'), 'utf8')).toContain(
      'The decision file is the deliverable',
    );
    const specWriter = readFileSync(join(agentsDir, 'factory-spec-writer.md'), 'utf8');
    expect(specWriter).toContain('The spec file is the deliverable');
    // job-0bda70aa turned "document next as an alias of status" into the reverse.
    expect(specWriter).toContain('never invert');
    const challenger = readFileSync(join(agentsDir, 'factory-spec-challenger.md'), 'utf8');
    expect(tools('factory-spec-challenger')).not.toContain('Edit');
    expect(tools('factory-spec-challenger')).toContain('Write'); // spec-review-N.md only
    expect(challenger).toContain('VERDICT');
    expect(challenger).toContain('The review file is the deliverable');
    // The simplifier only reports over-engineering; the builder applies what makes sense.
    expect(ROLES.find((x) => x.name === 'simplifier')?.agent).toBe('factory-simplifier');
    expect(tools('factory-simplifier')).not.toContain('Edit');
    expect(tools('factory-simplifier')).toContain('Write'); // round-N/simplify-review.md only
    expect(readFileSync(join(agentsDir, 'factory-simplifier.md'), 'utf8')).toContain(
      'The review file is the deliverable',
    );
    expect(readFileSync(join(agentsDir, 'factory-builder.md'), 'utf8')).toContain('simplify.md');
    expect(tools('factory-builder')).toContain('Edit');
    expect(tools('factory-spec-writer')).not.toContain('Edit');
  });

  it('a scope gap is rework, not a human decision (todo 0073)', () => {
    // Whitespace-normalized, so rewrapping the prose does not break the contract.
    const read = (agent: string) =>
      readFileSync(join(agentsDir, `${agent}.md`), 'utf8').replace(/\s+/g, ' ');
    const approver = read('factory-approver');
    expect(approver).toContain('REWORK-BUILD');
    expect(approver).toContain('REWORK-SPEC');
    for (const r of ROLES.filter((x) => x.kind === 'review')) {
      expect(read(r.agent), r.agent).toContain('A scope gap is BLOCKING, whatever your ownership');
    }
    expect(read('factory-spec-challenger')).toContain(
      'A spec that drops part of the request gets CHANGES unless the request itself or a human said to leave it out',
    );
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('orch job transition <id> rework');
    expect(skill).toContain('REWORK-SPEC');
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
      'orch factory cancel',
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
    expect(body).toContain('clearly died');
    expect(body.toLowerCase()).toContain('cannot restart');
  });

  it('records the claude-code session before the vscode-agents one, for the Session tab', () => {
    const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    const claude = body.indexOf(
      'orch job session attach <id> --provider claude-code --ref "$CLAUDE_CODE_SESSION_ID"',
    );
    expect(claude).toBeGreaterThan(-1);
    expect(body.indexOf('--provider vscode-agents --ref <openLink>')).toBeGreaterThan(claude);
  });

  it('defaults a single job to the interactive session and reads notices on every next', () => {
    const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    for (const phrase of [
      'interactive session',
      'plan.notices',
      'plan.noticeAck',
      'Any local process can',
      'information only',
      'never authorizes `--force`, a release, a cancel',
    ]) {
      expect(body, phrase).toContain(phrase);
    }
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
    expect(checkArtifact('spec-review-1.md', template('spec-review-N.md'))).toBe('pass');
    expect(checkArtifact('build.md', template('build.md'))).toBeNull();
    expect(
      checkArtifact('round-1/simplify-review.md', template('round-N/simplify-review.md')),
    ).toBeNull();
    expect(checkArtifact('round-1/simplify.md', template('round-N/simplify.md'))).toBeNull();
    expect(checkArtifact('round-1/review-ux.md', template('round-N/review-<reviewer>.md'))).toBe(
      'pass',
    );
    expect(checkArtifact('round-1/consolidated.md', template('round-N/consolidated.md'))).toBe('1');
    expect(checkArtifact('decision.md', template('decision.md'))).toBe('approve');
    expect(checkArtifact('pr.md', template('pr.md (also used as the PR body)'))).toBeNull();
    const fastPr = template('pr.md (fast job)');
    expect(checkArtifact('pr.md', fastPr)).toBeNull();
    for (const h of ['## Summary', '## Changed files', '## Validation', '## Known limitations']) {
      expect(fastPr, h).toContain(h);
    }
    // build.md's Validation lists each targeted check as run with its result, or as not run.
    expect(template('build.md')).toContain('not run');
  });

  it('the fast builder is the one fast-job agent and escalates instead of widening scope', () => {
    expect(ROLES.filter((r) => r.kind === 'fast-build').map((r) => r.agent)).toEqual([
      'factory-fast-builder',
    ]);
    const text = readFileSync(join(agentsDir, 'factory-fast-builder.md'), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    for (const phrase of [
      'Never widen scope',
      'ESCALATE: <reason>',
      'orch verify <jobId> --token <token>',
      'orch ticket edit <key> --body-file -',
      'not run',
      'The file is the deliverable',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(skill).toContain('factory-fast-builder');
    expect(skill).toContain('orch ticket reopen');
  });
});

describe('orch install with the real skill and agents', () => {
  it('links the factory skill and every agent into an isolated Claude directory', () => {
    const claude = tempDir('orch-claude-real-');
    dirs.push(claude);
    const dry = runInstall({ source: root, 'claude-dir': claude, 'dry-run': true });
    expect(dry.problems).toBe(false);
    expect(dry.entries.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(
      [
        'skill:factory',
        'skill:log-todo',
        'skill:dotodo',
        ...ROLES.map((r) => `agent:${r.agent}`),
      ].sort(),
    );
    const real = runInstall({ source: root, 'claude-dir': claude });
    expect(real.problems).toBe(false);
    expect(real.entries.every((e) => e.state === 'linked')).toBe(true);
    expect(readFileSync(join(claude, 'skills', 'factory', 'SKILL.md'), 'utf8')).toContain(
      'name: factory',
    );
    expect(existsSync(join(claude, 'skills', 'factory', 'reference.md'))).toBe(true);
    // The ticket skills are installed for every repository, from their project-skill location.
    for (const name of ['log-todo', 'dotodo']) {
      expect(readFileSync(join(claude, 'skills', name, 'SKILL.md'), 'utf8')).toContain(
        `name: ${name}`,
      );
    }
    expect(frontmatter(join(claude, 'agents', 'factory-builder.md'))['name']).toBe(
      'factory-builder',
    );
    // Repeating is a no-op and the links still resolve to this repository.
    const again = runInstall({ source: root, 'claude-dir': claude });
    expect(again.entries.map((e) => e.state)).toEqual(real.entries.map(() => 'linked'));
  });
});

describe('the todo skills use the ticket commands that exist', () => {
  const skill = (name: string) =>
    readFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), 'utf8');

  it('every orch ticket command a skill names is in orch ticket --help', () => {
    for (const name of ['log-todo', 'dotodo']) {
      const used = new Set([...skill(name).matchAll(/orch ticket ([a-z]+)/g)].map((m) => m[1]));
      expect(used.size).toBeGreaterThan(3);
      for (const cmd of used) {
        expect(TICKET_HELP, `${name} uses orch ticket ${String(cmd)}`).toContain(
          `\n  ${String(cmd)} `,
        );
      }
    }
  });

  it('neither skill writes the Markdown register any more, and dotodo links its job', () => {
    for (const name of ['log-todo', 'dotodo']) {
      expect(skill(name)).not.toMatch(/index\.mjs|INDEX\.md|todo\/NNNN/);
    }
    expect(existsSync(join(root, '.claude', 'skills', 'log-todo', 'index.mjs'))).toBe(false);
    expect(skill('dotodo')).toContain('--ticket <id>');
    expect(FACTORY_HELP).toContain('--ticket <id>');
  });

  it('dotodo merges only through orch job merge and knows every outcome it can print', () => {
    const text = skill('dotodo');
    expect(text).toContain('orch job merge <job> --json');
    expect(JOB_HELP).toContain('\n  merge <id> ');
    // No merge rule or gh merge command of its own: those live in mergeDecision and mergePr.
    expect(text).not.toMatch(/match-head-commit|headRefOid|mergeable/);
    expect(text).toContain('Never run `gh pr merge`');
    for (const outcome of MERGE_OUTCOMES) expect(text).toContain(`\`${outcome}\``);
    const codes = [...text.matchAll(/`code: ([a-z-]+)`/g)].map((m) => m[1]);
    expect(codes).toEqual(['not-authorized', 'second-conflict']);
    for (const code of codes) expect(MERGE_BLOCKS).toContain(code);
    // The opt-in is the user's: the skill names the command and is told not to run it.
    expect(text).toContain('orch factory config merge enable');
    expect(text).toContain('do not run it yourself');
    expect(FACTORY_HELP).toContain('config merge enable|disable|status');
  });
});
