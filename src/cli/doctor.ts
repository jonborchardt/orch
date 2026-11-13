import { execSync } from 'node:child_process';

import { findProjectRoot, installRoot, runtimePaths } from '../core/paths.ts';

export const MIN_NODE = '22.18.0';

export type Status = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: Status;
  detail: string;
}

/** Returns true when `actual` (e.g. "v24.1.0") is at least `min` (e.g. "22.18.0"). */
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
  try {
    // execSync uses the platform shell, which resolves .exe/.cmd shims on Windows.
    const out = execSync(`${tool} --version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return out.trim().split(/\r?\n/)[0];
  } catch {
    return undefined;
  }
}

function tool(name: string, label: string, missing: Status, hint: string): Check {
  const version = toolVersion(name);
  return version
    ? { name: label, status: 'ok', detail: version }
    : { name: label, status: missing, detail: `${name} not found on PATH. ${hint}` };
}

export function runDoctor(cwd: string = process.cwd()): Check[] {
  const paths = runtimePaths();
  const project = findProjectRoot(cwd);
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
    { name: 'Install root', status: 'ok', detail: installRoot() },
    { name: 'Config dir', status: 'ok', detail: paths.config },
    { name: 'Data dir', status: 'ok', detail: paths.data },
  ];
}

export function formatChecks(checks: Check[]): string {
  const icon: Record<Status, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
  return checks.map((c) => `${icon[c.status]} ${c.name.padEnd(20)} ${c.detail}`).join('\n');
}
