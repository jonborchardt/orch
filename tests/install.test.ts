import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInstall } from '../src/cli/install.ts';
import { json, orch, removeLink, tempDir } from './helpers.ts';

let source: string;
let claude: string;

beforeEach(() => {
  source = tempDir('orch-src-');
  claude = tempDir('orch-claude-');
  mkdirSync(join(source, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(source, 'skills', 'demo', 'SKILL.md'), '# demo\n');
  mkdirSync(join(source, 'skills', 'not-a-skill')); // no SKILL.md: ignored
  mkdirSync(join(source, 'agents'));
  writeFileSync(join(source, 'agents', 'planner.md'), '# planner\n');
  writeFileSync(join(source, 'agents', 'notes.txt'), 'ignored');
});
afterEach(() => {
  // Remove links first so rmSync never follows a junction into the source tree.
  rmSync(claude, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

describe('orch install', () => {
  it('dry-run reports what would be linked and creates nothing', () => {
    const r = runInstall({ source, 'claude-dir': claude, 'dry-run': true });
    expect(r.dryRun).toBe(true);
    expect(r.problems).toBe(false);
    expect(r.entries.map((e) => [e.kind, e.name, e.state])).toEqual([
      ['skill', 'demo', 'missing'],
      ['agent', 'planner', 'missing'],
    ]);
    expect(existsSync(join(claude, 'skills'))).toBe(false);
  });

  it('links skills as directories and agents as files; edits are live; repeat is a no-op', () => {
    const first = runInstall({ source, 'claude-dir': claude });
    expect(first.problems).toBe(false);
    expect(first.entries.every((e) => e.state === 'linked')).toBe(true);
    expect(first.entries[0]?.method).toBe('junction');
    expect(['symlink', 'hardlink']).toContain(first.entries[1]?.method);

    // Discovery paths Claude Code reads.
    const skill = join(claude, 'skills', 'demo');
    expect(lstatSync(skill).isSymbolicLink()).toBe(true);
    expect(readdirSync(skill)).toEqual(['SKILL.md']);
    expect(readFileSync(join(claude, 'agents', 'planner.md'), 'utf8')).toBe('# planner\n');

    // Not a copy: a change in the source shows through the link.
    writeFileSync(join(source, 'skills', 'demo', 'SKILL.md'), '# demo v2\n');
    expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toBe('# demo v2\n');

    const second = runInstall({ source, 'claude-dir': claude });
    expect(second.problems).toBe(false);
    expect(second.entries.map((e) => e.state)).toEqual(['linked', 'linked']);
  });

  it('never touches existing user paths and reports them as conflicts', () => {
    mkdirSync(join(claude, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(claude, 'skills', 'demo', 'SKILL.md'), 'mine\n');
    mkdirSync(join(claude, 'agents'));
    writeFileSync(join(claude, 'agents', 'planner.md'), 'mine too\n');

    const r = runInstall({ source, 'claude-dir': claude });
    expect(r.problems).toBe(true);
    expect(r.entries.map((e) => e.state)).toEqual(['conflict', 'conflict']);
    expect(r.entries[0]?.detail).toContain('not managed by orch');
    expect(readFileSync(join(claude, 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe('mine\n');
    expect(readFileSync(join(claude, 'agents', 'planner.md'), 'utf8')).toBe('mine too\n');
  });

  it('a link to a different source is a conflict, not silently repointed', () => {
    const other = tempDir('orch-other-');
    try {
      mkdirSync(join(other, 'skills', 'demo'), { recursive: true });
      writeFileSync(join(other, 'skills', 'demo', 'SKILL.md'), 'other\n');
      runInstall({ source: other, 'claude-dir': claude });
      const r = runInstall({ source, 'claude-dir': claude });
      expect(r.entries[0]?.state).toBe('conflict');
      expect(r.entries[0]?.detail).toContain('existing link points to');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('falls back to a marked copy that is refreshed when stale and never clobbers other files', () => {
    const first = runInstall({ source, 'claude-dir': claude, agentMethods: ['copy'] });
    expect(first.problems).toBe(false);
    const agent = first.entries.find((e) => e.kind === 'agent');
    expect(agent?.method).toBe('copy');
    const target = join(claude, 'agents', 'planner.md');
    expect(readFileSync(target, 'utf8')).toMatch(/^# planner\n\n<!-- orch-managed-copy: .+ -->\n$/);

    // Unchanged source: linked. Changed source: stale, then refreshed by a plain install.
    expect(runInstall({ source, 'claude-dir': claude, 'dry-run': true }).entries[1]?.state).toBe(
      'linked',
    );
    writeFileSync(join(source, 'agents', 'planner.md'), '# planner v2\n');
    const dry = runInstall({ source, 'claude-dir': claude, 'dry-run': true });
    expect(dry.entries[1]?.state).toBe('stale');
    expect(dry.problems).toBe(false);
    const refreshed = runInstall({ source, 'claude-dir': claude });
    expect(refreshed.entries[1]).toMatchObject({ state: 'linked', method: 'copy' });
    expect(refreshed.entries[1]?.detail).toBeUndefined();
    expect(readFileSync(target, 'utf8')).toContain('# planner v2');

    // A copy made from a different source, or a user's own file, is a conflict.
    const other = tempDir('orch-other-');
    try {
      mkdirSync(join(other, 'agents'));
      writeFileSync(join(other, 'agents', 'planner.md'), '# theirs\n');
      const r = runInstall({ source: other, 'claude-dir': claude, agentMethods: ['copy'] });
      expect(r.entries[0]?.state).toBe('conflict');
      expect(r.entries[0]?.detail).toContain('managed copy of another source');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    writeFileSync(target, '# user edited\n');
    const user = runInstall({ source, 'claude-dir': claude });
    expect(user.entries[1]?.state).toBe('conflict');
    expect(readFileSync(target, 'utf8')).toBe('# user edited\n');
  });

  it('recognises its own links and copies when the source is spelled differently', () => {
    // A junction (symlink elsewhere) to the source is another spelling of the same directory,
    // like a lower-case drive letter on Windows; links and marked copies must still be "ours".
    const alias = join(tempDir('orch-alias-'), 'src');
    try {
      symlinkSync(source, alias, 'junction');
    } catch {
      return; // no link support here; nothing to prove
    }
    try {
      runInstall({ source, 'claude-dir': claude, agentMethods: ['copy'] });
      const again = runInstall({ source: alias, 'claude-dir': claude, 'dry-run': true });
      expect(again.problems).toBe(false);
      expect(again.entries.map((e) => e.state)).toEqual(['linked', 'linked']);
      writeFileSync(join(source, 'agents', 'planner.md'), '# planner v3\n');
      expect(
        runInstall({ source: alias, 'claude-dir': claude, 'dry-run': true }).entries[1]?.state,
      ).toBe('stale');
    } finally {
      removeLink(alias);
      rmSync(join(alias, '..'), { recursive: true, force: true });
    }
  });

  it('is exposed on the CLI with --json and a nonzero exit on conflicts', () => {
    const home = tempDir('orch-home-');
    try {
      const dry = orch(home, tmpdir(), [
        '--json',
        'install',
        '--dry-run',
        '--source',
        source,
        '--claude-dir',
        claude,
      ]);
      expect(dry.code).toBe(0);
      expect(json<{ entries: unknown[] }>(dry).entries).toHaveLength(2);
      const human = orch(home, tmpdir(), ['install', '--source', source, '--claude-dir', claude]);
      expect(human.code).toBe(0);
      expect(human.out).toContain('LINKED');
      mkdirSync(join(source, 'agents', 'extra'));
      writeFileSync(join(claude, 'agents', 'extra.md'), 'user file\n');
      writeFileSync(join(source, 'agents', 'extra.md'), 'ours\n');
      const conflict = orch(home, tmpdir(), [
        'install',
        '--source',
        source,
        '--claude-dir',
        claude,
      ]);
      expect(conflict.code).toBe(1);
      expect(conflict.out).toContain('CONFLICT');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
