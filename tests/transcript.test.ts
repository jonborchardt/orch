/** The Session tab reader: parsing, subagents, read bounds, and real-path confinement (todo 0074). */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  confined,
  heldPath,
  LIMITS,
  mergeEntries,
  NO_SESSION,
  parseTranscript,
  readConfined,
  readSessionLog,
} from '../src/server/transcript.ts';
import type { SessionEntry } from '../src/server/types.ts';
import { tempDir } from './helpers.ts';

const { ENTRY_TEXT_MAX, MAX_ENTRIES, MAX_RESPONSE_BYTES, MAX_SUBAGENT_FILES } = LIMITS;
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
    // Never half of a surrogate pair: 9 x's and an emoji cut at 10 keeps the 9.
    const [e] = parseTranscript(user(0, `${'x'.repeat(9)}\u{1F600}tail`), null, 10);
    expect(e?.text).toBe('x'.repeat(9));
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
      reason: NO_SESSION,
      attach: ATTACH,
    });
    const noProjects = readSessionLog(claude, U, ATTACH);
    expect(noProjects).toMatchObject({ found: false, ref: U });
    expect(noProjects.reason).toContain(`Claude Code session ${U} is recorded for this job, but`);
    expect(noProjects.reason).toContain('no Claude Code projects directory exists at');
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

  it('caps the subagent type and description taken from a meta file (finding 6)', () => {
    const claude = tempDir('claude-');
    const project = writeSession(claude, 'p', user(0, 'main'));
    writeAgent(project, 'k1', user(1, 'agent'), {
      agentType: 't'.repeat(1000),
      description: 'd'.repeat(5000),
    });
    const v = readSessionLog(claude, U, ATTACH);
    expect(v.subagents[0]?.type).toBe('t'.repeat(200));
    expect(v.subagents[0]?.description).toBe('d'.repeat(200));
    expect(v.entries.find((e) => e.text === 'agent')?.agent?.description).toBe('d'.repeat(200));
  });

  it('resolves only the newest MAX_SUBAGENT_FILES candidates (finding 4)', () => {
    const outside = tempDir('outside-');
    writeFileSync(join(outside, 'x.jsonl'), user(5, 'outside'));
    const claude = tempDir('claude-');
    const project = writeSession(claude, 'p', user(0, 'main'));
    for (const id of ['o1', 'o2', 'o3']) writeAgent(project, id, user(1, `agent ${id}`));
    const old = new Date(Date.now() - 600_000);
    for (const id of ['o1', 'o2', 'o3'])
      utimesSync(join(project, U, 'subagents', `agent-${id}.jsonl`), old, old);
    // The newest candidate is a junction out of subagents/: it takes a slot and is refused,
    // rather than an older file being resolved in its place.
    symlinkSync(outside, join(project, U, 'subagents', 'agent-zz.jsonl'), 'junction');
    const v = readSessionLog(claude, U, ATTACH, { MAX_SUBAGENT_FILES: 2 });
    expect(v.subagents).toHaveLength(1);
    expect(v.subagentsNotRead).toBe(2);
    expect(JSON.stringify(v)).not.toContain('outside');
  });

  it('reads only through a handle proven inside root after the open, never an earlier check (finding 5, CI round 3)', () => {
    const root = tempDir('claude-');
    const outside = tempDir('outside-');
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', 'agent-a.jsonl'), 'inside');
    writeFileSync(join(outside, 'agent-a.jsonl'), 'outside');
    // The listing-time check passes and the read sees the file inside.
    const checked = confined(join(root, 'd', 'agent-a.jsonl'), root);
    if (!checked) throw new Error('expected the file to pass the check');
    expect(readConfined(checked.path, root, 64)?.buf.toString()).toBe('inside');
    // A directory on the checked path is swapped for a link out of root after that check: the
    // handle now opened is the outside file, and the proof on the open handle refuses it.
    renameSync(join(root, 'd'), join(root, 'd-old'));
    symlinkSync(outside, join(root, 'd'), 'junction');
    expect(readConfined(checked.path, root, 64)).toBeNull();
    // A directory is never read as a transcript (on Linux the read throws anyway; the FIFO case
    // below proves the regular-file check there).
    expect(readConfined(join(root, 'd-old'), root, 64)).toBeNull();
  });

  it.runIf(process.platform === 'linux')(
    'resolves the open handle, not the name, on Linux (ticket 0086)',
    () => {
      const root = tempDir('claude-');
      const outside = tempDir('outside-');
      mkdirSync(join(root, 'd'));
      writeFileSync(join(root, 'd', 'agent-a.jsonl'), 'inside');
      const fd = openSync(join(root, 'd', 'agent-a.jsonl'), 'r');
      try {
        // A directory on the path moves after the open: the handle's path follows it, which
        // resolving the old name cannot produce (that name is gone).
        renameSync(join(root, 'd'), join(root, 'moved'));
        expect(heldPath(fd, join(root, 'd', 'agent-a.jsonl'))).toBe(
          join(root, 'moved', 'agent-a.jsonl'),
        );
        expect(() => realpathSync(join(root, 'd', 'agent-a.jsonl'))).toThrow();
      } finally {
        closeSync(fd);
      }
      // A handle whose own path lies outside root is refused, though its name is under root.
      writeFileSync(join(outside, 'agent-b.jsonl'), 'outside');
      symlinkSync(outside, join(root, 'link'));
      expect(readConfined(join(root, 'link', 'agent-b.jsonl'), root, 64)).toBeNull();
      expect(readConfined(join(root, 'moved', 'agent-a.jsonl'), root, 64)?.buf.toString()).toBe(
        'inside',
      );
    },
  );

  it('refuses a handle whose resolved path inside root names a different file (ticket 0087)', () => {
    // Stands in for a won swap race: the path resolved after the open lies inside root and is a
    // regular file, but not the one held open. Only the identity comparison refuses it.
    const root = tempDir('claude-');
    writeFileSync(join(root, 'agent-a.jsonl'), 'held');
    writeFileSync(join(root, 'agent-b.jsonl'), 'other');
    const a = realpathSync(join(root, 'agent-a.jsonl'));
    const b = realpathSync(join(root, 'agent-b.jsonl'));
    expect(readConfined(a, root, 64, false, () => a)?.buf.toString()).toBe('held');
    expect(readConfined(a, root, 64, false, () => b)).toBeNull();
  });

  it.runIf(process.platform === 'linux')('never reads a FIFO as a transcript (ticket 0087)', () => {
    // A FIFO opens without blocking, passes the path and identity checks, and reads 0 bytes:
    // only the regular-file check refuses it. No writer is ever opened.
    const root = tempDir('claude-');
    const fifo = join(root, 'agent-a.jsonl');
    execFileSync('mkfifo', [fifo]);
    expect(readConfined(fifo, root, 64)).toBeNull();
  });

  it('proves the file at read time, so inode reuse cannot pass a stale identity (CI round 3)', () => {
    // Round 2 compared a stat taken at listing with an fstat taken after the open. On Linux a
    // deleted file's inode number goes to the next file created, so a file deleted and recreated
    // between the two carried the checked identity and was read (the Linux CI failure). Now the
    // identity is taken from the open handle, which pins its inode, and compared with the file at
    // the path resolved after the open; nothing from the listing is trusted. What that proves is
    // "a regular file inside root when it was read". A file replaced in place inside root is such
    // a file, on every platform, whatever inode it got: it is read, as any transcript there is.
    const root = tempDir('claude-');
    const file = join(root, 'agent-a.jsonl');
    writeFileSync(file, 'original');
    const checked = confined(file, root);
    if (!checked) throw new Error('expected the file to pass the check');
    rmSync(file);
    writeFileSync(join(root, 'other'), 'replaced');
    renameSync(join(root, 'other'), file);
    expect(readConfined(checked.path, root, 64)?.buf.toString()).toBe('replaced');
    // Gone between the listing and the read: nothing is read, nothing throws.
    rmSync(file);
    expect(readConfined(checked.path, root, 64)).toBeNull();
  });

  it('ignores a meta file larger than META_MAX_BYTES', () => {
    const claude = tempDir('claude-');
    const project = writeSession(claude, 'p', user(0, 'main'));
    writeAgent(project, 'm1', user(1, 'agent'), {
      agentType: 'builder',
      description: 'd'.repeat(200),
      finished: true,
    });
    const meta = (max: number) =>
      readSessionLog(claude, U, ATTACH, { META_MAX_BYTES: max }).subagents[0];
    expect(meta(16 * 1024)).toMatchObject({ type: 'builder', finished: true });
    expect(meta(64)).toMatchObject({ id: 'm1', type: null, description: null, finished: null });
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
