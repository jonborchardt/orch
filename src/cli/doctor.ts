import { existsSync } from 'node:fs';

import { runTool } from '../core/exec.ts';
import {
  claudeHome,
  databasePath,
  findProjectRoot,
  installRoot,
  runtimePaths,
} from '../core/paths.ts';
import { planInstall } from '../integrations/claude.ts';
import { checkReadiness } from '../ops/init.ts';

export const MIN_NODE = '24.0.0';

export type Status = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: Status;
  detail: string;
}

/** Returns true when `actual` (e.g. "v24.1.0") is at least `min` (e.g. "24.0.0"). */
export function nodeVersionOk(actual: string, min: string = MIN_NODE): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [a, b] = [parse(actual), parse(min)];
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** First line of `<tool> --version`, or undefined if the tool is not on PATH. */
export function toolVersion(tool: string): string | undefined {
  return runTool(tool, ['--version'])?.split(/\r?\n/)[0];
}

function tool(name: string, label: string, missing: Status, hint: string): Check {
  const version = toolVersion(name);
  return version
    ? { name: label, status: 'ok', detail: version }
    : { name: label, status: missing, detail: `${name} not found on PATH. ${hint}` };
}

/** Installed skill/agent links versus this checkout: stale managed copies are the usual drift. */
function installCheck(claudeDir: string): Check {
  const entries = planInstall(installRoot(), claudeDir);
  const off = entries.filter((e) => e.state !== 'linked');
  if (off.length === 0) {
    return {
      name: 'Skills and agents',
      status: 'ok',
      detail: `${String(entries.length)} linked into ${claudeDir}`,
    };
  }
  return {
    name: 'Skills and agents',
    status: 'warn',
    detail:
      off.map((e) => `${e.kind} ${e.name}: ${e.state}`).join(', ') +
      '. Run `orch install` to link or refresh them.',
  };
}

/** The repository's verification policy as the factory would trust it; `orch init --check` has the detail. */
function policyCheck(cwd: string): Check {
  const r = checkReadiness(cwd);
  return {
    name: 'Verification policy',
    status: r.ready ? 'ok' : 'warn',
    detail: r.ready ? r.detail : `${r.status}: ${r.detail}${r.next ? ` ${r.next}` : ''}`,
  };
}

export function runDoctor(cwd: string = process.cwd(), claudeDir: string = claudeHome()): Check[] {
  const paths = runtimePaths();
  const project = findProjectRoot(cwd);
  const db = databasePath(paths);
  return [
    {
      name: 'Node.js',
      status: nodeVersionOk(process.version) ? 'ok' : 'fail',
      detail: `${process.version} (requires >= ${MIN_NODE})`,
    },
    tool('git', 'Git', 'fail', 'Install Git and ensure it is on PATH.'),
    tool('claude', 'Claude Code', 'warn', 'Install Claude Code to run factory jobs.'),
    tool('gh', 'GitHub CLI', 'warn', 'Optional; needed later for draft PRs.'),
    {
      name: 'Project repository',
      status: project ? 'ok' : 'warn',
      detail: project ?? `${cwd} is not inside a Git repository.`,
    },
    policyCheck(cwd),
    { name: 'Install root', status: 'ok', detail: installRoot() },
    { name: 'Config dir', status: 'ok', detail: paths.config },
    { name: 'Data dir', status: 'ok', detail: paths.data },
    {
      name: 'Database',
      status: 'ok',
      detail: `${db} (${existsSync(db) ? 'exists' : 'will be created on first use'})`,
    },
    installCheck(claudeDir),
  ];
}

export function formatChecks(checks: Check[]): string {
  const icon: Record<Status, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  return checks.map((c) => `${icon[c.status]} ${c.name.padEnd(20)} ${c.detail}`).join('\n');
}
