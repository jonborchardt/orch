import { claudeHome, installRoot } from '../core/paths.ts';
import {
  type AgentMethod,
  applyInstall,
  type LinkEntry,
  planInstall,
} from '../integrations/claude.ts';

export interface InstallOptions {
  'dry-run'?: boolean;
  'claude-dir'?: string;
  source?: string;
  /** Test hook: restrict how agent files may be installed. */
  agentMethods?: readonly AgentMethod[];
}

export interface InstallReport {
  source: string;
  claudeDir: string;
  dryRun: boolean;
  entries: LinkEntry[];
  /** True when any entry is in conflict or failed to link. */
  problems: boolean;
}

export function formatInstall(r: InstallReport): string {
  const lines = [`${r.dryRun ? 'Would link' : 'Linking'} ${r.source} -> ${r.claudeDir}`];
  if (r.entries.length === 0) lines.push('(no skills/ or agents/ found in source)');
  for (const e of r.entries) {
    const how = e.method ? ` [${e.method}]` : '';
    lines.push(
      `${e.state.toUpperCase().padEnd(8)} ${e.kind} ${e.name}${how} -> ${e.target}${e.detail ? `: ${e.detail}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function runInstall(o: InstallOptions): InstallReport {
  const source = o.source ?? installRoot();
  const claudeDir = o['claude-dir'] ?? claudeHome();
  const dryRun = o['dry-run'] ?? false;
  const planned = planInstall(source, claudeDir);
  const entries = dryRun ? planned : applyInstall(planned, o.agentMethods);
  return {
    source,
    claudeDir,
    dryRun,
    entries,
    problems: entries.some((e) => e.state === 'conflict' || e.state === 'error'),
  };
}
