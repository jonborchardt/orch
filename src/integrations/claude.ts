/**
 * Links source-controlled skills and agents into the user's global Claude Code directory.
 *
 *   <source>/skills/<name>/SKILL.md  ->  <claude>/skills/<name>   (directory junction on Windows)
 *   <source>/agents/<name>.md        ->  <claude>/agents/<name>.md (symlink, else hardlink,
 *                                                                   else a marked managed copy)
 *
 * Nothing is copied when a link is possible, so edits in the repository are live. Existing paths
 * that are not our links or our marked copies are reported as conflicts and never touched.
 */
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { canonicalPath } from '../core/paths.ts';

export type LinkState = 'linked' | 'missing' | 'stale' | 'conflict' | 'error';
export type LinkMethod = 'junction' | 'symlink' | 'hardlink' | 'copy';

export interface LinkEntry {
  kind: 'skill' | 'agent';
  name: string;
  source: string;
  target: string;
  state: LinkState;
  method?: LinkMethod;
  detail?: string;
}

/** Trailer appended to managed copies so they can be recognised and refreshed. */
const COPY_MARKER = /\n<!-- orch-managed-copy: (.+) -->\n$/;

function withMarker(content: string, source: string): string {
  return `${content.replace(/\s*$/, '')}\n\n<!-- orch-managed-copy: ${source} -->\n`;
}

function sameFile(a: string, b: string): boolean {
  try {
    const [sa, sb] = [statSync(a), statSync(b)];
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

function inspect(entry: Omit<LinkEntry, 'state'>): LinkEntry {
  let st;
  try {
    st = lstatSync(entry.target);
  } catch {
    return { ...entry, state: 'missing' };
  }
  if (st.isSymbolicLink()) {
    let real: string | undefined;
    try {
      real = realpathSync(entry.target);
    } catch {
      real = undefined;
    }
    // Canonical comparison: the install root may be spelled differently from one invocation to
    // the next (drive-letter case on Windows, a junction versus its target).
    if (real !== undefined && canonicalPath(real) === canonicalPath(entry.source)) {
      return { ...entry, state: 'linked', method: entry.kind === 'skill' ? 'junction' : 'symlink' };
    }
    return { ...entry, state: 'conflict', detail: `existing link points to ${real ?? '(broken)'}` };
  }
  if (entry.kind === 'agent' && st.isFile()) {
    if (sameFile(entry.source, entry.target))
      return { ...entry, state: 'linked', method: 'hardlink' };
    const content = readFileSync(entry.target, 'utf8');
    const marker = COPY_MARKER.exec(content);
    if (marker?.[1] !== undefined && canonicalPath(marker[1]) === canonicalPath(entry.source)) {
      // Compare bodies, not the whole file: the trailer records whichever spelling wrote it.
      const body = (s: string) => s.replace(COPY_MARKER, '');
      return body(content) === body(withMarker(readFileSync(entry.source, 'utf8'), entry.source))
        ? { ...entry, state: 'linked', method: 'copy' }
        : { ...entry, state: 'stale', method: 'copy', detail: 'copy differs from source' };
    }
    if (marker) {
      return {
        ...entry,
        state: 'conflict',
        detail: `managed copy of another source: ${marker[1] ?? '?'}`,
      };
    }
  }
  return { ...entry, state: 'conflict', detail: 'existing path is not managed by orch' };
}

/** Discover skills/agents under `sourceRoot` and inspect their targets under `claudeDir`. */
export function planInstall(sourceRoot: string, claudeDir: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  const skillsDir = join(sourceRoot, 'skills');
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md'))) {
        entries.push(
          inspect({
            kind: 'skill',
            name: d.name,
            source: join(skillsDir, d.name),
            target: join(claudeDir, 'skills', d.name),
          }),
        );
      }
    }
  }
  const agentsDir = join(sourceRoot, 'agents');
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith('.md')) {
        entries.push(
          inspect({
            kind: 'agent',
            name: f.slice(0, -3),
            source: join(agentsDir, f),
            target: join(claudeDir, 'agents', f),
          }),
        );
      }
    }
  }
  return entries;
}

export type AgentMethod = Exclude<LinkMethod, 'junction'>;
export const AGENT_METHODS: readonly AgentMethod[] = ['symlink', 'hardlink', 'copy'];

/** The entry without the state it had before linking (a stale copy's `detail` must not linger). */
function identity(entry: LinkEntry): Omit<LinkEntry, 'state'> {
  return { kind: entry.kind, name: entry.name, source: entry.source, target: entry.target };
}

function linkAgent(entry: LinkEntry, methods: readonly AgentMethod[]): LinkEntry {
  const errors: string[] = [];
  for (const method of methods) {
    try {
      switch (method) {
        case 'symlink':
          symlinkSync(entry.source, entry.target, 'file');
          break;
        case 'hardlink':
          // Needs no privilege on Windows but only works on the same volume.
          linkSync(entry.source, entry.target);
          break;
        case 'copy':
          // Last resort (Windows without Developer Mode, repo on another drive): a marked copy
          // that `orch install` recognises and refreshes. Not live; rerun install after edits.
          writeFileSync(entry.target, withMarker(readFileSync(entry.source, 'utf8'), entry.source));
          break;
      }
      return { ...identity(entry), state: 'linked', method };
    } catch (err) {
      errors.push(`${method}: ${(err as Error).message}`);
    }
  }
  return {
    ...entry,
    state: 'error',
    detail: `${errors.join('; ')}. Enable Windows Developer Mode or keep the repo on the same drive as ${entry.target}.`,
  };
}

function link(entry: LinkEntry, methods: readonly AgentMethod[]): LinkEntry {
  mkdirSync(join(entry.target, '..'), { recursive: true });
  if (entry.kind === 'skill') {
    try {
      // 'junction' needs no privilege on Windows and is ignored (plain symlink) elsewhere.
      symlinkSync(entry.source, entry.target, 'junction');
      return { ...identity(entry), state: 'linked', method: 'junction' };
    } catch (err) {
      return { ...entry, state: 'error', detail: (err as Error).message };
    }
  }
  return linkAgent(entry, methods);
}

/**
 * Create links for missing entries and refresh stale managed copies. Linked entries are left
 * alone; conflicts are never touched. `agentMethods` orders the fallbacks for agent files.
 */
export function applyInstall(
  entries: LinkEntry[],
  agentMethods: readonly AgentMethod[] = AGENT_METHODS,
): LinkEntry[] {
  return entries.map((e) => {
    if (e.state === 'missing') return link(e, agentMethods);
    if (e.state === 'stale') return link(e, ['copy']);
    return e;
  });
}
