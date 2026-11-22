/** `orch backup create|restore`: local archives of orch's persistent data (ops/backup.ts). */
import { resolve } from 'node:path';

import { UsageError } from '../core/errors.ts';
import { HOME_ENV, runtimePaths } from '../core/paths.ts';
import {
  type BackupResult,
  createBackup,
  type RestoreResult,
  restoreBackup,
} from '../ops/backup.ts';
import { need } from './args.ts';

export const BACKUP_HELP = `Usage: orch backup create <file> [--force]
       orch backup restore <file> [--data-dir <dir>]

  create <file>    Write one .tar.gz holding a consistent SQLite snapshot of the database,
                   every file under jobs/<id>/artifacts/ and tickets/<id>/assets/, and a
                   versioned manifest. Safe while orch runs. The archive is validated before it
                   is renamed into place. Refused inside the data directory, the orch
                   installation, the Claude Code directory, or a Git working tree; an existing
                   <file> is kept unless --force replaces it.
  restore <file>   Install a backup into the data directory (or --data-dir <dir>, the directory
                   ORCH_HOME=<dir> selects; created if missing). Refused when the destination
                   holds a database, jobs/ or tickets/ content, or a live controller, recovery
                   worker or orch verify. Validates everything in a staging directory first and
                   migrates an older schema forward; a backup from a newer orch is refused.

Not backed up or recreated: worktrees, repositories, branches, controllers, workers, queues,
logs, and user configuration. Copy the archive to another drive: a same-disk backup does not
survive a disk failure.
`;

export interface BackupOutcome {
  data: BackupResult | RestoreResult;
  text: string;
}

function formatCreate(r: BackupResult): string {
  return [
    `Backup written and validated: ${r.path}`,
    `Database: ${String(r.rows)} rows in ${String(Object.keys(r.tables).length)} tables`,
    `Files: ${String(r.files)} (${String(r.artifacts)} artifact, ${String(r.assets)} asset)`,
    ...(r.skipped.length
      ? ['Skipped (not regular files):', ...r.skipped.map((s) => `  ${s.path}: ${s.reason}`)]
      : []),
    'Excluded:',
    ...r.excluded.map((e) => `  ${e}`),
  ].join('\n');
}

function formatRestore(r: RestoreResult): string {
  return [
    `Restored into ${r.destination}`,
    `Database: ${String(r.rows)} rows in ${String(Object.keys(r.tables).length)} tables` +
      (r.migrationsApplied ? `, ${String(r.migrationsApplied)} migrations applied` : ''),
    `Files: ${String(r.files)}`,
    'Not recreated:',
    ...r.notRecreated.map((n) => `  ${n}`),
  ].join('\n');
}

export function runBackup(
  args: string[],
  o: { force?: boolean | undefined; 'data-dir'?: string | undefined },
): BackupOutcome {
  const [sub, file, extra] = args;
  if (extra !== undefined) throw new UsageError(`Unexpected argument: ${extra}\n\n${BACKUP_HELP}`);
  switch (sub) {
    case 'create': {
      const r = createBackup(runtimePaths(), need(file, '<file>', BACKUP_HELP), { force: o.force });
      return { data: r, text: formatCreate(r) };
    }
    case 'restore': {
      if (o.force) throw new UsageError('restore never overwrites data; it has no --force.');
      const dir = o['data-dir'];
      // --data-dir <dir> is exactly the data directory ORCH_HOME=<dir> selects.
      const paths = dir ? runtimePaths({ [HOME_ENV]: resolve(dir) }) : runtimePaths();
      const r = restoreBackup(need(file, '<file>', BACKUP_HELP), paths);
      return { data: r, text: formatRestore(r) };
    }
    default:
      throw new UsageError(BACKUP_HELP);
  }
}
