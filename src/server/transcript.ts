/**
 * The Session tab's read model: the tail of a job's Claude Code transcript and of its subagents'
 * transcripts, read directly from `<claude home>/projects/` (decision
 * 2026-11-20-session-tab-reads-transcripts). The caller ties the session to the job (a claude-code
 * `session.attached` UUID); this module only finds `<projects>/<dir>/<uuid>.jsonl` and
 * `<dir>/<uuid>/subagents/agent-<id>.jsonl`. Every file must resolve, by real path, inside the real
 * projects directory (a subagent file also inside its real `subagents/`) and be a regular file.
 * Every read is bounded; `parseTranscript` and `mergeEntries` are pure.
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
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

export const LIMITS = {
  TAIL_WINDOW_BYTES,
  TOTAL_READ_BYTES,
  MAX_SUBAGENT_FILES,
  META_MAX_BYTES,
  MAX_ENTRIES,
  ENTRY_TEXT_MAX,
  MAX_RESPONSE_BYTES,
};
export type Limits = typeof LIMITS;

const AGENT_FILE = /^agent-([0-9a-z]+)\.jsonl$/;
/** Inputs that name what a tool call is about, preferred first (Bash: description, then command). */
const KEY_INPUTS = ['description', 'file_path', 'pattern', 'url', 'query', 'command'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const firstLine = (s: string) => s.trim().split(/\r?\n/, 1)[0] ?? '';

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
      out.push({ at, kind, text: truncated ? t.slice(0, entryTextMax) : t, truncated, agent });
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

interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * The real path of `p` with its stats when it lies inside the real directory `root` and is a
 * regular file (`dir`: a directory); null when it is missing, elsewhere, or another kind.
 */
function confined(p: string, root: string, dir = false): Found | null {
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

/** Up to `length` bytes of `file` from byte `start`; never more, even if the file grew. */
function readAt(file: string, start: number, length: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** A meta file's fields; empty when it is absent, larger than `max`, or not a JSON object. */
function readMeta(file: Found | null, max: number): Obj {
  if (!file || file.size > max) return {};
  try {
    const m: unknown = JSON.parse(readAt(file.path, 0, file.size).toString('utf8'));
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
    return { ...view, ref: null, reason: 'No Claude Code session is attached to this job.' };
  }
  const dir = join(claudeDir, 'projects');
  let projects: string;
  let names: string[];
  try {
    projects = realpathSync(dir);
    names = readdirSync(projects);
  } catch {
    return { ...view, reason: `No Claude Code projects directory at ${dir}.` };
  }
  const seen = new Set<string>();
  const matches = names
    .flatMap((n) => confined(join(projects, n, `${ref}.jsonl`), projects) ?? [])
    .filter((f) => !seen.has(f.path) && seen.add(f.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const main = matches[0];
  if (!main) {
    return { ...view, reason: `No transcript ${ref}.jsonl in any project directory under ${dir}.` };
  }

  // The session's own `subagents/`, itself inside projects; each file inside it.
  const sub = confined(join(dirname(main.path), ref, 'subagents'), projects, true)?.path ?? '';
  const agents = (sub ? readdirSync(sub) : [])
    .flatMap((n) => {
      const id = AGENT_FILE.exec(n)?.[1];
      const f = id ? confined(join(sub, n), sub) : null;
      return f && id ? [{ ...f, id }] : [];
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const read = agents.slice(0, L.MAX_SUBAGENT_FILES);

  const subagents: SubagentSummary[] = read.map((f) => {
    const m = readMeta(confined(join(sub, `agent-${f.id}.meta.json`), sub), L.META_MAX_BYTES);
    return {
      id: f.id,
      type: str(m['agentType']),
      description: str(m['description']),
      finished: typeof m['finished'] === 'boolean' ? m['finished'] : null,
      modifiedAt: new Date(f.mtimeMs).toISOString(),
    };
  });
  const sources = [
    { file: main, source: 'main', agent: null as SessionAgent | null },
    ...read.map((f, i) => {
      const s = subagents[i];
      return {
        file: f,
        source: `agent-${f.id}`,
        agent: { id: f.id, type: s?.type ?? null, description: s?.description ?? null },
      };
    }),
  ].sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);

  let budget = L.TOTAL_READ_BYTES;
  const lists: SessionEntry[][] = [];
  const files: SessionFile[] = [];
  for (const { file, source, agent } of sources) {
    const n = Math.max(0, Math.min(L.TAIL_WINDOW_BYTES, file.size, budget));
    budget -= n;
    let text = '';
    try {
      text = n > 0 ? readAt(file.path, file.size - n, n).toString('utf8') : '';
    } catch {
      /* unreadable now: reported with what was read, nothing parsed */
    }
    // A cut start lands mid-record: drop the partial first line.
    if (n < file.size) text = text.slice(text.indexOf('\n') + 1 || text.length);
    lists.push(parseTranscript(text, agent, L.ENTRY_TEXT_MAX));
    files.push({
      source,
      size: file.size,
      bytesRead: n,
      truncated: n < file.size,
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
    subagentsNotRead: agents.length - read.length,
    entries,
    truncated:
      files.some((f) => f.truncated) || agents.length > read.length || all > entries.length,
  };
  return fitResponse(out, L.MAX_RESPONSE_BYTES);
}

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
