import { claudeHome, installRoot } from '../core/paths.ts';
import { applyInstall, type LinkEntry, planInstall } from '../integrations/claude.ts';

export interface InstallOptions {
  'dry-run'?: boolean;
  'claude-dir'?: string;
  source?: string;
}

export interface InstallReport {
  source: string;
  claudeDir: string;
  dryRun: boolean;
  entries: LinkEntry[];
  /** True when any entry is in conflict or failed to link. */
  problems: boolean;
}

export function runInstall(o: InstallOptions): InstallReport {
  const source = o.source ?? installRoot();
  const claudeDir = o['claude-dir'] ?? claudeHome();
  const dryRun = o['dry-run'] ?? false;
  const planned = planInstall(source, claudeDir);
  const entries = dryRun ? planned : applyInstall(planned);
  return {
    source,
    claudeDir,
    dryRun,
    entries,
    problems: entries.some((e) => e.state === 'conflict' || e.state === 'error'),
  };
}
