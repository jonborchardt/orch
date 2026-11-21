/**
 * The Markdown todo register that tickets replaced: one `NNNN-slug.md` per todo with thirteen
 * frontmatter keys in a fixed order, and an `areas.md` of `name: description` lines. Parsed only
 * by the one-shot import (ops/ticket-import.ts); the rules are those of the retired
 * `.claude/skills/log-todo/index.mjs`. Pure: text in, values out.
 */
import { ValidationError } from './errors.ts';
import {
  type Area,
  AREA_NAME,
  CLASSIFIED,
  type Classified,
  dependencyPath,
  EFFORTS,
  PRIORITIES,
  type Priority,
  TICKET_STATUSES,
  TICKET_TYPES,
  type TicketStatus,
  type TicketType,
} from './tickets.ts';

export const REGISTER_KEYS = [
  'id',
  'title',
  'status',
  'type',
  'area',
  'priority',
  'effort',
  'depends_on',
  'related',
  'duplicate_of',
  'classified',
  'created',
  'updated',
] as const;

export const TODO_FILE = /^\d{4}-.*\.md$/;

export interface RegisterTodo {
  file: string;
  id: number;
  title: string;
  status: TicketStatus;
  type: TicketType;
  area: string;
  priority: Priority;
  effort: number;
  dependsOn: number[];
  related: number[];
  duplicateOf: number | null;
  classified: Classified;
  /** `YYYY-MM-DD`, kept as written. */
  created: string;
  updated: string;
  /** Everything after the frontmatter, line endings normalized, outer blank lines trimmed. */
  body: string;
}

function refuse(file: string, line: number | null, why: string): never {
  throw new ValidationError(`${file}${line === null ? '' : `:${String(line)}`}: ${why}`);
}

export function parseTodo(text: string, file: string): RegisterTodo {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') refuse(file, 1, 'frontmatter must start with ---');
  const end = lines.indexOf('---', 1);
  if (end < 0) refuse(file, 1, 'frontmatter has no closing ---');
  const raw = new Map<string, string>();
  const seen: string[] = [];
  const at = new Map<string, number>();
  for (let i = 1; i < end; i++) {
    const m = /^([a-z_]+):\s?(.*)$/.exec(lines[i] ?? '');
    if (!m) refuse(file, i + 1, 'not a key: value line');
    const key = m[1] ?? '';
    if (!(REGISTER_KEYS as readonly string[]).includes(key))
      refuse(file, i + 1, `unknown key ${key}`);
    seen.push(key);
    at.set(key, i + 1);
    // A trailing comment starts after two spaces.
    raw.set(key, (m[2] ?? '').replace(/\s{2,}#.*$/, '').trim());
  }
  if (seen.join() !== REGISTER_KEYS.join()) {
    refuse(
      file,
      2,
      `keys must be exactly, in order: ${REGISTER_KEYS.join(', ')} (got ${seen.join(', ')})`,
    );
  }
  const value = (key: (typeof REGISTER_KEYS)[number]) => raw.get(key) ?? '';
  const bad = (key: string, why: string) => refuse(file, at.get(key) ?? 2, `${key}: ${why}`);
  const pick = <T extends string>(
    key: (typeof REGISTER_KEYS)[number],
    allowed: readonly T[],
  ): T => {
    const v = value(key);
    return allowed.includes(v as T) ? (v as T) : bad(key, `one of ${allowed.join(', ')}`);
  };
  const ids = (key: 'depends_on' | 'related'): number[] => {
    const m = /^\[(.*)\]$/.exec(value(key));
    if (!m) return bad(key, 'an array like [1, 2]');
    const parts = (m[1] ?? '').trim() ? (m[1] ?? '').split(',').map((s) => s.trim()) : [];
    if (parts.some((s) => !/^\d+$/.test(s))) bad(key, 'ids only');
    return parts.map(Number);
  };
  const date = (key: 'created' | 'updated'): string =>
    /^\d{4}-\d{2}-\d{2}$/.test(value(key)) ? value(key) : bad(key, 'YYYY-MM-DD');

  if (!/^\d+$/.test(value('id'))) bad('id', 'must be an integer');
  if (!value('title')) bad('title', 'empty');
  if (!AREA_NAME.test(value('area'))) bad('area', 'kebab-case name');
  if (!EFFORTS.includes(Number(value('effort'))))
    bad('effort', `days, one of ${EFFORTS.join(', ')}`);
  const dup = value('duplicate_of');
  if (dup !== 'null' && !/^\d+$/.test(dup)) bad('duplicate_of', 'an id or null');

  const todo: RegisterTodo = {
    file,
    id: Number(value('id')),
    title: value('title').replace(/^"(.*)"$/, '$1'),
    status: pick('status', TICKET_STATUSES),
    type: pick('type', TICKET_TYPES),
    area: value('area'),
    priority: pick('priority', PRIORITIES),
    effort: Number(value('effort')),
    dependsOn: ids('depends_on'),
    related: ids('related'),
    duplicateOf: dup === 'null' ? null : Number(dup),
    classified: pick('classified', CLASSIFIED),
    created: date('created'),
    updated: date('updated'),
    body: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^\n+/, '')
      .trimEnd(),
  };
  if ((todo.status === 'duplicate') !== (todo.duplicateOf !== null)) {
    refuse(file, 2, 'duplicate_of is set exactly when status is duplicate');
  }
  const fromName = /^(\d{4})-/.exec(file);
  if (!fromName || Number(fromName[1]) !== todo.id) {
    refuse(file, 2, `id ${String(todo.id)} does not match the filename`);
  }
  return todo;
}

export function parseAreas(text: string): Area[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const m = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(l);
      if (!m) refuse('areas.md', null, `not a 'name: description' line: ${l}`);
      return { name: m[1] ?? '', description: m[2] ?? '' };
    });
}

/**
 * Cross-file rules: unique ids, known areas, references that exist, no dependency cycle. Returns
 * warnings for what the old index only warned about.
 */
export function validateRegister(todos: readonly RegisterTodo[], areas: readonly Area[]): string[] {
  const byId = new Map<number, RegisterTodo>();
  for (const t of todos) {
    const other = byId.get(t.id);
    if (other) refuse(t.file, 2, `id ${String(t.id)} is also ${other.file}`);
    byId.set(t.id, t);
  }
  const names = new Set(areas.map((a) => a.name));
  const warnings: string[] = [];
  for (const t of todos) {
    if (!names.has(t.area)) refuse(t.file, 2, `area ${t.area} is not in areas.md`);
    for (const [key, list] of [
      ['depends_on', t.dependsOn],
      ['related', t.related],
    ] as const) {
      for (const id of list) {
        if (!byId.has(id)) refuse(t.file, 2, `${key} names ${String(id)}, which does not exist`);
      }
    }
    if (t.dependsOn.includes(t.id)) refuse(t.file, 2, 'depends on itself');
    if (t.duplicateOf !== null && !byId.has(t.duplicateOf)) {
      refuse(t.file, 2, `duplicate_of names ${String(t.duplicateOf)}, which does not exist`);
    }
    if (t.status === 'open' || t.status === 'in-progress') {
      for (const id of t.dependsOn) {
        const d = byId.get(id);
        if (d?.status === 'dropped')
          warnings.push(`${t.file} depends on ${String(id)}, which is dropped`);
        if (d?.status === 'duplicate') {
          warnings.push(
            `${t.file} depends on ${String(id)}, a duplicate of ${String(d.duplicateOf)}: point at that instead`,
          );
        }
      }
    }
  }
  const deps = new Map(todos.map((t) => [t.id, t.dependsOn]));
  for (const t of todos) {
    for (const d of t.dependsOn) {
      const path = dependencyPath(deps, d, t.id);
      if (path) refuse(t.file, 2, `dependency cycle: ${[t.id, ...path].join(' -> ')}`);
    }
  }
  return warnings;
}
