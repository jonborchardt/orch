/**
 * The Session tab's read model: the tail of a job's Claude Code transcript and of its subagents'
 * transcripts, read directly from `<claude home>/projects/` (decision
 * 2026-11-20-session-tab-reads-transcripts). The caller ties the session to the job (a claude-code
 * `session.attached` UUID); this module only finds `<projects>/<dir>/<uuid>.jsonl` and
 * `<dir>/<uuid>/subagents/agent-<id>.jsonl`. Every file must resolve, by real path, inside the real
 * projects directory (a subagent file also inside its real `subagents/`) and be a regular file.
 * Every read is bounded; `parseTranscript` and `mergeEntries` are pure.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { UUID } from '../core/session.ts';
import type {
  SessionAgent,
  SessionEntry,
  SessionEntryKind,
  SessionFile,
  SessionLogView,
  SubagentSummary,
} from './types.ts';

/** Bytes read from the end of each transcript file. */
export const TAIL_WINDOW_BYTES = 256 * 1024;
/** Bytes read across all files of one request, newest file first. */
export const TOTAL_READ_BYTES = 2 * 1024 * 1024;
/** Newest subagent files read (by modification time); the rest are counted. */
export const MAX_SUBAGENT_FILES = 24;
/** Bytes read from each `agent-<id>.meta.json`. */
export const META_MAX_BYTES = 16 * 1024;
/** Entries in one response, newest first. */
export const MAX_ENTRIES = 400;
/** Characters of one entry's text. */
export const ENTRY_TEXT_MAX = 4000;
/** Bytes of the serialized response. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Characters of a subagent's type or description from its meta file. */
export const META_TEXT_MAX = 200;

export const LIMITS = {
  TAIL_WINDOW_BYTES,
  TOTAL_READ_BYTES,
  MAX_SUBAGENT_FILES,
  META_MAX_BYTES,
  MAX_ENTRIES,
  ENTRY_TEXT_MAX,
  MAX_RESPONSE_BYTES,
  META_TEXT_MAX,
};
export type Limits = typeof LIMITS;

const AGENT_FILE = /^agent-([0-9a-z]+)\.jsonl$/;
/** Inputs that name what a tool call is about, preferred first (Bash: description, then command). */
const KEY_INPUTS = ['description', 'file_path', 'pattern', 'url', 'query', 'command'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const firstLine = (s: string) => s.trim().split(/\r?\n/, 1)[0] ?? '';

/** At most `n` UTF-16 units of `s`, never ending on half of a surrogate pair. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

function toolLine(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  if (name === 'Agent' || name === 'Task') {
    const what = [str(i['subagent_type']), str(i['description'])].filter(Boolean).join(': ');
    return what ? `${name} ${what}` : name;
  }
  for (const k of KEY_INPUTS) {
    const v = str(i[k]);
    if (v) return `${name} ${firstLine(v)}`;
  }
  return name;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b: unknown) => (isObj(b) && typeof b['text'] === 'string' ? [b['text']] : []))
    .join('\n');
}

/**
 * Normalize JSONL transcript text into entries, in file order. Thinking blocks, records other than
 * user, assistant, and error system records, and malformed or partial lines are skipped; in the
 * main file (`agent` null) so are sidechain records.
 */
export function parseTranscript(
  text: string,
  agent: SessionAgent | null,
  entryTextMax: number = ENTRY_TEXT_MAX,
): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const line of text.split('\n')) {
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(r)) continue;
    const at = r['timestamp'];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) continue;
    if (agent === null && r['isSidechain'] === true) continue;
    const push = (kind: SessionEntryKind, raw: string) => {
      const t = raw.trim();
      if (!t) return;
      const truncated = t.length > entryTextMax;
      out.push({ at, kind, text: truncated ? clip(t, entryTextMax) : t, truncated, agent });
    };
    if (r['type'] === 'system') {
      if (r['level'] === 'error') push('error', str(r['content']) ?? 'System error');
      continue;
    }
    const kind = r['type'];
    const msg = r['message'];
    if ((kind !== 'user' && kind !== 'assistant') || !isObj(msg)) continue;
    const content = msg['content'];
    if (typeof content === 'string') {
      push(kind, content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content as unknown[]) {
      if (!isObj(b)) continue;
      if (b['type'] === 'text' && typeof b['text'] === 'string') push(kind, b['text']);
      else if (b['type'] === 'tool_use' && typeof b['name'] === 'string')
        push('tool', toolLine(b['name'], b['input']));
      else if (b['type'] === 'tool_result')
        push(
          b['is_error'] === true ? 'error' : 'result',
          resultText(b['content']) || '(no output)',
        );
    }
  }
  return out;
}

/** One timeline from several files' entries (each in file order): newest first, at most `max`. */
export function mergeEntries(lists: SessionEntry[][], max: number = MAX_ENTRIES): SessionEntry[] {
  return lists
    .flatMap((l) => l.map((e, i) => ({ e, i, t: Date.parse(e.at) })))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .slice(0, max)
    .map((x) => x.e);
}

/** A candidate file: its real path and the stats used to order and budget the reads. */
export interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * The real path of `p` with its stats when it lies inside the real directory `root` and is a
 * regular file (`dir`: a directory); null when it is missing, elsewhere, or another kind. A filter
 * only; reads go through `readConfined`.
 */
export function confined(p: string, root: string, dir = false): Found | null {
  try {
    const real = realpathSync(p);
    if (!real.startsWith(root + sep)) return null;
    const st = statSync(real);
    return (dir ? st.isDirectory() : st.isFile())
      ? { path: real, size: st.size, mtimeMs: st.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

/**
 * Non-blocking open where the platform has it, so a FIFO swapped in cannot hang the server. The
 * typings declare `O_NONBLOCK` everywhere; Windows does not define it at runtime.
 */
const READ_FLAGS = constants.O_RDONLY | ((constants as Partial<typeof constants>).O_NONBLOCK ?? 0);

/**
 * The real path of the file open as `fd`, opened by the name `p`. On Linux the handle's own path,
 * from `/proc/self/fd/<fd>` (a deleted file reads `<path> (deleted)` and fails the identity check
 * that follows); elsewhere, or without `/proc`, `p` resolved again by name.
 */
export function heldPath(fd: number, p: string): string {
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/self/fd/${String(fd)}`);
    } catch {
      // No /proc mounted: fall back to the by-name check below.
    }
  }
  return realpathSync(p);
}

/**
 * Open `p` once, then prove that this open handle is a regular file whose path, resolved after the
 * open, lies inside the real directory `root`: the file at that real path must have the handle's
 * device and inode (compared as bigints; NTFS file ids exceed a double). Read only through that
 * handle: up to `length` bytes from the start, or the last `length` bytes (`fromEnd`). Null when
 * the proof fails or anything cannot be read.
 *
 * Why after the open: an open handle pins its inode, so no other file can take its number while
 * the identities are compared. Never trust an identity taken before the open: a deleted file's
 * inode number goes to the next file created (at once on Linux).
 *
 * The swap race: a directory on the path that is a link out at the open, the real directory at
 * the path check, and a link out again at the identity check. Closed on Linux, where `heldPath`
 * reads the open handle's own path. It remains on Windows and macOS, where Node has no
 * handle-to-path call (no `GetFinalPathNameByHandle`, no `F_GETPATH`) and the path is resolved
 * by name. Winning it needs write access to the user's own Claude projects directory, whose owner
 * can already read every transcript.
 */
export function readConfined(
  p: string,
  root: string,
  length: number,
  fromEnd = false,
): { buf: Buffer; size: number } | null {
  let fd: number;
  try {
    fd = openSync(p, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const held = fstatSync(fd, { bigint: true });
    if (!held.isFile()) return null;
    const real = heldPath(fd, p);
    if (!real.startsWith(root + sep)) return null;
    const there = statSync(real, { bigint: true });
    if (there.dev !== held.dev || there.ino !== held.ino) return null;
    const size = Number(held.size);
    const n = Math.min(length, size);
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, fromEnd ? size - n : 0);
    return { buf: buf.subarray(0, got), size };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A directory's entries, or none when it cannot be listed (for example gone mid-request). */
function list(dir: string): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A meta file's fields; empty when it is absent, larger than `max`, or not a JSON object. */
function readMeta(path: string, root: string, max: number): Obj {
  // At most `max` bytes are read; a file larger than that is ignored, never parsed in part.
  const read = readConfined(path, root, max);
  if (!read || read.size > max) return {};
  try {
    const m: unknown = JSON.parse(read.buf.toString('utf8'));
    return isObj(m) ? m : {};
  } catch {
    return {};
  }
}

/**
 * The bounded Session tab view for claude-code session `ref` under `claudeDir`. Never throws for
 * missing, unreadable, or malformed files: they are reported as not found or skipped.
 */
export function readSessionLog(
  claudeDir: string,
  ref: string | null,
  attach: string,
  limits: Partial<Limits> = {},
): SessionLogView {
  const L = { ...LIMITS, ...limits };
  const view: SessionLogView = {
    found: false,
    reason: null,
    ref,
    attach,
    matches: 0,
    files: [],
    subagents: [],
    subagentsNotRead: 0,
    entries: [],
    truncated: false,
  };
  if (ref === null || !UUID.test(ref)) {
    return { ...view, ref: null, reason: NO_SESSION };
  }
  const dir = join(claudeDir, 'projects');
  let projects: string;
  let names: string[];
  try {
    projects = realpathSync(dir);
    names = readdirSync(projects);
  } catch {
    return {
      ...view,
      reason: `${recorded(ref)} no Claude Code projects directory exists at ${dir}. ${ELSEWHERE}`,
    };
  }
  const seen = new Set<string>();
  const matches = names
    .flatMap((n) => confined(join(projects, n, `${ref}.jsonl`), projects) ?? [])
    .filter((f) => !seen.has(f.path) && seen.add(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const main = matches[0];
  if (!main) {
    return {
      ...view,
      reason:
        `${recorded(ref)} its transcript ${ref}.jsonl was not found in any project directory ` +
        `under ${dir}. ${ELSEWHERE}`,
    };
  }

  // The session's own `subagents/`, itself inside projects; each file inside it.
  const sub = confined(join(dirname(main.path), ref, 'subagents'), projects, true)?.path ?? '';
  // Ordered by one cheap lstat each; only the newest MAX_SUBAGENT_FILES are resolved and checked.
  const candidates = list(sub)
    .flatMap((name) => {
      const id = AGENT_FILE.exec(name)?.[1];
      if (!id) return [];
      try {
        return [{ id, name, mtimeMs: lstatSync(join(sub, name)).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const chosen = candidates.slice(0, L.MAX_SUBAGENT_FILES);
  const read = chosen.flatMap((c) => {
    const f = confined(join(sub, c.name), sub);
    return f ? [{ ...f, id: c.id }] : [];
  });
  const metaText = (v: unknown) => {
    const t = str(v);
    return t === null ? null : clip(t, L.META_TEXT_MAX);
  };

  const subagents: SubagentSummary[] = read.map((f) => {
    const m = readMeta(join(sub, `agent-${f.id}.meta.json`), sub, L.META_MAX_BYTES);
    return {
      id: f.id,
      type: metaText(m['agentType']),
      description: metaText(m['description']),
      finished: typeof m['finished'] === 'boolean' ? m['finished'] : null,
      modifiedAt: new Date(f.mtimeMs).toISOString(),
    };
  });
  const sources = [
    { file: main, root: projects, source: 'main', agent: null as SessionAgent | null },
    ...read.map((f, i) => {
      const s = subagents[i];
      return {
        file: f,
        root: sub,
        source: `agent-${f.id}`,
        agent: { id: f.id, type: s?.type ?? null, description: s?.description ?? null },
      };
    }),
  ].sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);

  let budget = L.TOTAL_READ_BYTES;
  const lists: SessionEntry[][] = [];
  const files: SessionFile[] = [];
  for (const { file, root, source, agent } of sources) {
    const want = Math.max(0, Math.min(L.TAIL_WINDOW_BYTES, file.size, budget));
    // Refused or unreadable now: reported with nothing read, nothing parsed.
    const got = want > 0 ? readConfined(file.path, root, want, true) : null;
    const bytes = got?.buf.length ?? 0;
    const size = got?.size ?? file.size;
    budget -= bytes;
    let text = got?.buf.toString('utf8') ?? '';
    // A cut start lands mid-record: drop the partial first line.
    if (bytes < size) text = text.slice(text.indexOf('\n') + 1 || text.length);
    lists.push(parseTranscript(text, agent, L.ENTRY_TEXT_MAX));
    files.push({
      source,
      size,
      bytesRead: bytes,
      truncated: bytes < size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
    });
  }
  const all = lists.reduce((sum, l) => sum + l.length, 0);
  const entries = mergeEntries(lists, L.MAX_ENTRIES);
  const out: SessionLogView = {
    ...view,
    found: true,
    matches: matches.length,
    files,
    subagents,
    subagentsNotRead: candidates.length - chosen.length,
    entries,
    truncated:
      files.some((f) => f.truncated) || candidates.length > chosen.length || all > entries.length,
  };
  return fitResponse(out, L.MAX_RESPONSE_BYTES);
}

/** The empty state when no claude-code session is tied: no instruction anyone at the dashboard runs. */
export const NO_SESSION =
  "No Claude Code session is recorded for this job. A job's session records itself when it starts " +
  'or resumes through /factory; jobs started before session logs were recorded have none.';
const recorded = (ref: string) => `Claude Code session ${ref} is recorded for this job, but`;
const ELSEWHERE = 'It may be under another Claude home (CLAUDE_CONFIG_DIR) or on another machine.';

/** Drop the oldest entries until the serialized view fits in `max` bytes. */
function fitResponse(view: SessionLogView, max: number): SessionLogView {
  // Measured with `truncated: false`, never shorter than `true`, so the bound holds either way.
  let used = Buffer.byteLength(JSON.stringify({ ...view, entries: [], truncated: false }));
  let n = 0;
  for (const e of view.entries) {
    const b = Buffer.byteLength(JSON.stringify(e)) + 1;
    if (used + b > max) break;
    used += b;
    n++;
  }
  return n === view.entries.length
    ? view
    : { ...view, entries: view.entries.slice(0, n), truncated: true };
}
