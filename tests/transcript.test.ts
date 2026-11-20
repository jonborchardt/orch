/** The Session tab reader: parsing, subagents, read bounds, and real-path confinement (todo 0074). */
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENTRY_TEXT_MAX,
  MAX_ENTRIES,
  MAX_RESPONSE_BYTES,
  MAX_SUBAGENT_FILES,
  mergeEntries,
  parseTranscript,
  readSessionLog,
} from '../src/server/transcript.ts';
import type { SessionEntry } from '../src/server/types.ts';
import { tempDir } from './helpers.ts';
import {
  assistant,
  at,
  mainTranscript,
  U,
  user,
  writeAgent,
  writeSession,
} from './transcript-fixture.ts';

const ATTACH = 'orch job session attach <id> ...';
const kinds = (es: SessionEntry[]) => es.map((e) => e.kind);
const texts = (es: SessionEntry[]) => es.map((e) => e.text);

describe('parseTranscript', () => {
  it('turns records into user, assistant, tool, result, and error entries, skipping the rest', () => {
    const es = parseTranscript(mainTranscript(), null);
    expect(es.map((e) => [e.kind, e.text])).toEqual([
      ['user', 'Please build the export button'],
      ['assistant', 'Running the tests.'],
      ['tool', 'Bash Run tests'],
      ['result', '12 passed\nall good'],
      ['error', 'boom'],
      ['error', 'API error 529'],
      ['tool', 'Agent factory-builder: Build round 1'],
      ['tool', 'Read /repo/src/a.ts'],
    ]);
    expect(es.every((e) => e.agent === null && !e.truncated)).toBe(true);
    const all = JSON.stringify(es);
    expect(all).not.toContain('secret reasoning');
    expect(all).not.toContain('sidechain text');
  });

  it('keeps sidechain records in a subagent file and names tools by their key input', () => {
    const agent = { id: 'a1', type: 'builder', description: 'Build' };
    const side = { isSidechain: true };
    const es = parseTranscript(
      [
        user(1, 'do it', side),
        assistant(
          2,
          [
            { type: 'tool_use', name: 'Bash', input: { command: 'git status\ngit log' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO', path: 'src' } },
            { type: 'tool_use', name: 'Mystery', input: { n: 1 } },
          ],
          side,
        ),
      ].join('\n'),
      agent,
    );
    expect(texts(es)).toEqual(['do it', 'Bash git status', 'Grep TODO', 'Mystery']);
    expect(es.every((e) => e.agent === agent)).toBe(true);
  });

  it('caps each entry text and marks it truncated', () => {
    expect(parseTranscript(user(0, 'x'.repeat(50)), null, 10)).toEqual([
      { at: at(0), kind: 'user', text: 'x'.repeat(10), truncated: true, agent: null },
    ]);
  });
});

describe('mergeEntries', () => {
  it('orders all files by timestamp, newest first, keeping file order on ties', () => {
    const e = (s: number, text: string): SessionEntry => ({
      at: at(s),
      kind: 'user',
      text,
      truncated: false,
      agent: null,
    });
    const merged = mergeEntries(
      [
        [e(1, 'a'), e(3, 'c'), e(3, 'd')],
        [e(2, 'b'), e(4, 'x')],
      ],
      4,
    );
    expect(texts(merged)).toEqual(['x', 'd', 'c', 'b']);
  });
});

describe('readSessionLog', () => {
  it('reads the main session newest first, with no agent (AC1)', () => {
    const claude = tempDir('claude-');
    writeSession(claude);
    const v = readSessionLog(claude, U, ATTACH);
    expect(v).toMatchObject({ found: true, reason: null, ref: U, matches: 1, subagents: [] });
    const times = v.entries.map((e) => e.at);
    expect(times).toEqual([...times].sort().reverse());
    expect(new Set(kinds(v.entries))).toEqual(
      new Set(['user', 'assistant', 'tool', 'result', 'error']),
    );
    expect(v.entries.every((e) => e.agent === null)).toBe(true);
    expect(v.files).toEqual([expect.objectContaining({ source: 'main', truncated: false })]);
    expect(v.truncated).toBe(false);
  });

  it('merges subagent entries by time and lists the subagents, with or without meta (AC2)', () => {
    const claude = tempDir('claude-');
    const project = writeSession(claude);
    const side = { isSidechain: true };
    writeAgent(
      project,
      'a1',
      [
        user(4, 'builder starts', side),
        assistant(7, [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.ts' } }], side),
      ].join('\n'),
      { agentType: 'builder', description: 'Build round 1', finished: false, toolUseId: 't3' },
    );
    writeAgent(project, 'a2', user(5, 'second agent', side));
    const v = readSessionLog(claude, U, ATTACH);
    const t = texts(v.entries);
    // 7 (a1) sits between main's 8 and 6; 5 (a2) and 4 (a1) between main's 6 and 3.
    expect(t.slice(t.indexOf('API error 529'), t.indexOf('12 passed\nall good') + 1)).toEqual([
      'API error 529',
      'Edit src/x.ts',
      'boom',
      'second agent',
      'builder starts',
      '12 passed\nall good',
    ]);
    expect(v.entries.find((e) => e.text === 'Edit src/x.ts')?.agent).toEqual({
      id: 'a1',
      type: 'builder',
      description: 'Build round 1',
    });
    expect(v.entries.find((e) => e.text === 'second agent')?.agent).toEqual({
      id: 'a2',
      type: null,
      description: null,
    });
    expect(v.subagents.map((s) => [s.id, s.type, s.finished]).sort()).toEqual([
      ['a1', 'builder', false],
      ['a2', null, null],
    ]);
    expect(v.subagentsNotRead).toBe(0);
    expect(v.files.map((f) => f.source).sort()).toEqual(['agent-a1', 'agent-a2', 'main']);
  });

  it('says why nothing was found, and treats a missing subagents directory as none (AC3)', () => {
    const claude = tempDir('claude-');
    expect(readSessionLog(claude, null, ATTACH)).toMatchObject({
      found: false,
      reason: 'No Claude Code session is attached to this job.',
      attach: ATTACH,
    });
    expect(readSessionLog(claude, U, ATTACH).found).toBe(false);
    writeSession(claude, 'E--repo', mainTranscript(), '99999999-2222-4333-8444-555555555555');
    const none = readSessionLog(claude, U, ATTACH);
    expect(none.found).toBe(false);
    expect(none.reason).toContain(`${U}.jsonl`);
    writeSession(claude);
    expect(readSessionLog(claude, U, ATTACH)).toMatchObject({ found: true, subagents: [] });
  });

  it('reads the newest of two matching transcripts with its own subagents (AC3)', () => {
    const claude = tempDir('claude-');
    const old = writeSession(claude, 'e--repo', user(0, 'old copy'));
    writeAgent(old, 'b1', user(1, 'old agent'));
    const fresh = writeSession(claude, 'E--repo-2', user(0, 'new copy'));
    writeAgent(fresh, 'c1', user(1, 'new agent'));
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(old, `${U}.jsonl`), past, past);
    const v = readSessionLog(claude, U, ATTACH);
    expect(v.matches).toBe(2);
    expect(texts(v.entries)).toEqual(['new agent', 'new copy']);
    expect(v.subagents.map((s) => s.id)).toEqual(['c1']);
  });

  it('ignores subagent files that are not agent-<id>.jsonl (AC4)', () => {
    const claude = tempDir('claude-');
    const project = writeSession(claude, 'p', user(0, 'main'));
    writeAgent(project, 'ok1', user(1, 'kept'));
    const sub = join(project, U, 'subagents');
    for (const n of ['agent-ok1.meta.json', 'notes.jsonl', 'agent-UP.jsonl', 'agent-x.jsonl.bak'])
      writeFileSync(join(sub, n), user(2, `ignored ${n}`));
    const v = readSessionLog(claude, U, ATTACH);
    expect(texts(v.entries)).toEqual(['kept', 'main']);
    expect(v.subagents.map((s) => s.id)).toEqual(['ok1']);
  });

  it('refuses a main file, subagent file, or subagents directory leading outside projects (AC4)', () => {
    const outside = tempDir('outside-');
    writeFileSync(join(outside, `${U}.jsonl`), user(0, 'outside main'));
    writeFileSync(join(outside, 'agent-z1.jsonl'), user(1, 'outside agent'));
    const junction = (target: string, path: string) => {
      symlinkSync(target, path, 'junction');
    };
    /** A file symlink needs a privilege Windows rarely grants; false when it cannot be made. */
    const fileLink = (target: string, path: string) => {
      try {
        symlinkSync(target, path, 'file');
        return true;
      } catch {
        return false;
      }
    };
    const leaks = (claude: string) => JSON.stringify(readSessionLog(claude, U, ATTACH));

    // A project directory that is a junction out of projects.
    const a = tempDir('claude-');
    mkdirSync(join(a, 'projects'));
    junction(outside, join(a, 'projects', 'evil'));
    expect(readSessionLog(a, U, ATTACH).found).toBe(false);
    // A main "file" that is a junction out of projects, or a file symlink.
    const a2 = tempDir('claude-');
    mkdirSync(join(a2, 'projects', 'p'), { recursive: true });
    junction(outside, join(a2, 'projects', 'p', `${U}.jsonl`));
    expect(readSessionLog(a2, U, ATTACH).found).toBe(false);
    const a3 = tempDir('claude-');
    mkdirSync(join(a3, 'projects', 'p'), { recursive: true });
    if (fileLink(join(outside, `${U}.jsonl`), join(a3, 'projects', 'p', `${U}.jsonl`))) {
      expect(readSessionLog(a3, U, ATTACH).found).toBe(false);
    }

    // A subagents directory that is a junction out of projects.
    const b = tempDir('claude-');
    const pb = writeSession(b, 'p', user(0, 'main'));
    mkdirSync(join(pb, U));
    junction(outside, join(pb, U, 'subagents'));
    const vb = readSessionLog(b, U, ATTACH);
    expect(vb.found).toBe(true);
    expect(vb.subagents).toEqual([]);
    expect(leaks(b)).not.toContain('outside');

    // Subagent entries that are a junction or a file symlink out of subagents/.
    const c = tempDir('claude-');
    const pc = writeSession(c, 'p', user(0, 'main'));
    writeAgent(pc, 'ok', user(1, 'inside agent'));
    const sub = join(pc, U, 'subagents');
    junction(outside, join(sub, 'agent-z9.jsonl'));
    fileLink(join(outside, 'agent-z1.jsonl'), join(sub, 'agent-z1.jsonl'));
    const vc = readSessionLog(c, U, ATTACH);
    expect(texts(vc.entries)).toEqual(['inside agent', 'main']);
    expect(vc.subagents.map((s) => s.id)).toEqual(['ok']);
    expect(leaks(c)).not.toContain('outside');
  });

  it('never reads a ref that is not a UUID', () => {
    const claude = tempDir('claude-');
    writeSession(claude, 'p', user(0, 'x'), 'not-a-uuid');
    expect(readSessionLog(claude, 'not-a-uuid', ATTACH).found).toBe(false);
  });

  it('reads only bounded tails, newest file first (AC5)', () => {
    const claude = tempDir('claude-');
    const pad = 'm'.repeat(60);
    const big = Array.from({ length: 400 }, (_, i) => user(i, `main ${String(i)} ${pad}`));
    const project = writeSession(claude, 'p', big.join('\n'));
    for (let i = 0; i < 6; i++) {
      const id = `s${String(i)}`;
      writeAgent(
        project,
        id,
        Array.from({ length: 60 }, (_, j) => user(j, `${id} ${pad}`)).join('\n'),
      );
      const t = new Date(Date.now() - (i + 1) * 60_000);
      utimesSync(join(project, U, 'subagents', `agent-${id}.jsonl`), t, t);
    }
    const v = readSessionLog(claude, U, ATTACH, {
      TAIL_WINDOW_BYTES: 4096,
      TOTAL_READ_BYTES: 10 * 1024,
      MAX_SUBAGENT_FILES: 4,
    });
    for (const f of v.files) expect(f.bytesRead).toBeLessThanOrEqual(4096);
    expect(v.files.reduce((s, f) => s + f.bytesRead, 0)).toBeLessThanOrEqual(10 * 1024);
    const main = v.files.find((f) => f.source === 'main');
    expect(main?.truncated).toBe(true);
    expect(main?.size).toBeGreaterThan(4 * 4096);
    const mainTexts = texts(v.entries.filter((e) => e.agent === null));
    expect(mainTexts.some((t) => t.startsWith('main 399 '))).toBe(true);
    expect(mainTexts.some((t) => t.startsWith('main 0 '))).toBe(false);
    // The four newest subagents are read; the other two are counted.
    expect(v.subagents.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3']);
    expect(v.subagentsNotRead).toBe(2);
    expect(v.truncated).toBe(true);
  });

  it('keeps the default response within its byte, entry, and text caps (AC5)', () => {
    const claude = tempDir('claude-');
    const huge = 'h'.repeat(ENTRY_TEXT_MAX * 2);
    const body = Array.from({ length: 600 }, (_, i) => user(i, `${String(i)} ${huge}`)).join('\n');
    expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
    const project = writeSession(claude, 'p', body);
    for (let i = 0; i < MAX_SUBAGENT_FILES + 5; i++) {
      const lines = Array.from({ length: 40 }, (_, j) => user(j, `${huge} ${String(j)}`));
      writeAgent(project, `g${String(i)}`, lines.join('\n'));
    }
    const v = readSessionLog(claude, U, ATTACH);
    expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(v.entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(v.entries.length).toBeGreaterThan(0);
    for (const e of v.entries) {
      expect(e.text.length).toBeLessThanOrEqual(ENTRY_TEXT_MAX);
      expect(e.truncated).toBe(true);
    }
    expect(v.subagentsNotRead).toBe(5);
    expect(v.truncated).toBe(true);
  });
});
