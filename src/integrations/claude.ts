/**
 * Links source-controlled skills and agents into the user's global Claude Code directory.
 *
 *   <source>/skills/<name>/SKILL.md  ->  <claude>/skills/<name>   (directory junction on Windows)
 *   <source>/agents/<name>.md        ->  <claude>/agents/<name>.md (symlink, else hardlink)
 *
 * Nothing is copied, so edits in the repository are live. Existing paths that are not our links
 * are reported as conflicts and never touched.
 */
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export type LinkState = 'linked' | 'missing' | 'conflict' | 'error';
export type LinkMethod = 'junction' | 'symlink' | 'hardlink';

export interface LinkEntry {
  kind: 'skill' | 'agent';
  name: string;
  source: string;
  target: string;
  state: LinkState;
  method?: LinkMethod;
  detail?: string;
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
    if (real !== undefined && real === realpathSync(entry.source)) {
      return { ...entry, state: 'linked', method: entry.kind === 'skill' ? 'junction' : 'symlink' };
    }
    return { ...entry, state: 'conflict', detail: `existing link points to ${real ?? '(broken)'}` };
  }
  if (entry.kind === 'agent' && st.isFile() && sameFile(entry.source, entry.target)) {
    return { ...entry, state: 'linked', method: 'hardlink' };
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

function link(entry: LinkEntry): LinkEntry {
  mkdirSync(join(entry.target, '..'), { recursive: true });
  if (entry.kind === 'skill') {
    // 'junction' needs no privilege on Windows and is ignored (plain symlink) elsewhere.
    symlinkSync(entry.source, entry.target, 'junction');
    return { ...entry, state: 'linked', method: 'junction' };
  }
  try {
    symlinkSync(entry.source, entry.target, 'file');
    return { ...entry, state: 'linked', method: 'symlink' };
  } catch (err) {
    // Windows without Developer Mode: file symlinks need elevation. Hard links do not, but
    // only work on the same volume.
    try {
      linkSync(entry.source, entry.target);
      return { ...entry, state: 'linked', method: 'hardlink' };
    } catch {
      return {
        ...entry,
        state: 'error',
        detail: `${(err as Error).message}. Enable Windows Developer Mode or keep the repo on the same drive as ${entry.target}.`,
      };
    }
  }
}

/** Create links for missing entries. Linked entries are left alone; conflicts are never touched. */
export function applyInstall(entries: LinkEntry[]): LinkEntry[] {
  return entries.map((e) => (e.state === 'missing' ? link(e) : e));
}
